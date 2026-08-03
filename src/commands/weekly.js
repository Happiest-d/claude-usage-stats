/** Понедельная агрегация по рабочим дням — данные для дашборда.
 *
 * Диапазон режется на недели пн–пт; суббота и воскресенье не учитываются.
 */
import { parseRange, workdayWeeks } from '../clock.js';
import { EDIT_TOOLS, TokenCounter, editedLines, isHumanPrompt, iterRecords, modelOf, toolUses } from '../logs.js';
import { activeHours, eventKind, gapIntervals, sessionIntervals, sweep, totalHours, round2 } from '../metrics.js';

const TOP_TOOLS = ['Bash', 'Read', 'Edit', 'Write'];

const MODEL_NAMES = {
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-fable-5': 'Fable 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

export const prettyModel = (model) => MODEL_NAMES[model] ?? model;

const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

function bucket(map, key, make = () => new Map()) {
  let inner = map.get(key);
  if (inner === undefined) {
    inner = make();
    map.set(key, inner);
  }
  return inner;
}

export async function collect(ctx) {
  const weeks = workdayWeeks(ctx.clock, ctx.start, ctx.end);
  if (weeks.length === 0) return { window: ctx.window(), weeks: [], daily: [] };

  // понедельник -> [начало, конец) рабочей недели, обрезанной по границам периода
  const spans = new Map();
  for (const [monday, friday] of weeks) {
    const { start, end } = parseRange(ctx.clock, monday, friday);
    spans.set(monday, [Math.max(start, ctx.start), Math.min(end, ctx.end)]);
  }
  const weekOf = (t) => {
    const key = ctx.clock.weekStart(t);
    const span = spans.get(key);
    return span && span[0] <= t && t < span[1] ? key : null;
  };

  const totals = new Map();
  const tools = new Map();
  const models = new Map();
  const files = new Map();
  const sessions = new Map();
  const sessionEvents = new Map(); // "неделя\0sessionId" -> [[время, вид]]
  const agentTimes = new Map(); // "неделя\0ключ агента" -> [время]
  const dayTimes = new Map();
  const dayStats = new Map();
  const tokens = new TokenCounter();

  for await (const rec of iterRecords(ctx.files(), ctx.start, ctx.end)) {
    const week = weekOf(rec.t);
    if (week === null) continue;

    const day = ctx.clock.day(rec.t);
    bucket(dayTimes, day, () => []).push(rec.t);
    if (rec.sessionId && !rec.isSubagent) bucket(sessions, week, () => new Set()).add(rec.sessionId);
    if (rec.sessionId) {
      bucket(sessionEvents, `${week}\0${rec.sessionId}`, () => []).push([rec.t, eventKind(rec)]);
      const agentKey = rec.isSubagent ? rec.file : rec.sessionId;
      bucket(agentTimes, `${week}\0${agentKey}`, () => []).push(rec.t);
    }

    if (isHumanPrompt(rec)) {
      bump(bucket(totals, week), 'prompts');
      bump(bucket(dayStats, day), 'prompts');
    }

    for (const [name, input] of toolUses(rec)) {
      bump(bucket(tools, week), name);
      bump(bucket(totals, week), 'tool_calls');
      bump(bucket(dayStats, day), 'tool_calls');
      if (EDIT_TOOLS.has(name)) {
        if (input.file_path) bucket(files, week, () => new Set()).add(input.file_path);
        const [added, removed] = editedLines(name, input);
        bump(bucket(totals, week), 'lines_added', added);
        bump(bucket(totals, week), 'lines_removed', removed);
      }
    }

    const usage = tokens.add(rec);
    if (usage === null) continue;
    for (const [key, value] of Object.entries(usage)) {
      bump(bucket(totals, week), key, value);
      bump(bucket(dayStats, day), key, value);
    }
    bump(bucket(totals, week), 'api_calls');
    bump(bucket(dayStats, day), 'api_calls');
    const model = modelOf(rec);
    if (!model.startsWith('<')) bump(bucket(models, week), prettyModel(model)); // <synthetic> — служебные записи без модели
    if (rec.isSidechain) bump(bucket(totals, week), 'sub_api_calls');
  }

  // интервалы: по каждой паре (неделя, агент) отдельно, затем в общий список недели
  const sessionIv = new Map();
  const agentIv = new Map();
  for (const [key, events] of sessionEvents) {
    const week = key.slice(0, key.indexOf('\0'));
    bucket(sessionIv, week, () => []).push(...sessionIntervals(events, ctx.idleGap));
  }
  for (const [key, times] of agentTimes) {
    const week = key.slice(0, key.indexOf('\0'));
    bucket(agentIv, week, () => []).push(...gapIntervals(times, ctx.idleGap));
  }

  const outWeeks = [];
  for (const [monday, friday] of weeks) {
    const t = bucket(totals, monday);
    const get = (key) => t.get(key) ?? 0;
    const ivs = sessionIv.get(monday) ?? [];
    const { byLevel, peak } = sweep(ivs);
    const wall = [...byLevel.values()].reduce((a, b) => a + b, 0) / 3600;
    const agentH = totalHours(ivs);
    const allIvs = agentIv.get(monday) ?? [];
    const all = sweep(allIvs);
    const allWall = [...all.byLevel.values()].reduce((a, b) => a + b, 0) / 3600;
    const allHours = totalHours(allIvs);

    const weekTools = tools.get(monday) ?? new Map();
    const grouped = Object.fromEntries(TOP_TOOLS.map((name) => [name, weekTools.get(name) ?? 0]));
    grouped['Прочие'] = [...weekTools.entries()]
      .filter(([name]) => !TOP_TOOLS.includes(name))
      .reduce((acc, [, n]) => acc + n, 0);

    const levels = {};
    for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
      levels[String(level)] = round2(byLevel.get(level) / 3600);
    }
    const multi = [...byLevel.entries()]
      .filter(([level]) => level >= 2)
      .reduce((acc, [, sec]) => acc + sec, 0) / 3600;

    outWeeks.push({
      key: monday,
      label: `${monday.slice(8)}.${monday.slice(5, 7)}–${friday.slice(8)}.${friday.slice(5, 7)}`,
      prompts: get('prompts'),
      api: get('api_calls'),
      sub_api: get('sub_api_calls'),
      tool_calls: get('tool_calls'),
      sessions: sessions.get(monday)?.size ?? 0,
      output: get('output'),
      input: get('input'),
      cache_read: get('cache_read'),
      cache_write: get('cache_write'),
      files: files.get(monday)?.size ?? 0,
      added: get('lines_added'),
      removed: get('lines_removed'),
      agent_h: round2(agentH),
      wall_h: round2(wall),
      conc: wall ? round2(agentH / wall) : 0,
      peak_sessions: peak,
      multi_h: round2(multi),
      levels,
      all_agent_h: round2(allHours),
      all_wall_h: round2(allWall),
      all_conc: allWall ? round2(allHours / allWall) : 0,
      peak_agents: all.peak,
      tools: grouped,
      models: Object.fromEntries([...(models.get(monday) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])),
    });
  }

  const daily = [];
  for (const day of [...dayTimes.keys()].sort()) {
    const times = dayTimes.get(day);
    const stats = dayStats.get(day) ?? new Map();
    daily.push({
      date: day,
      week: ctx.clock.weekStart(ctx.clock.dayStart(day)),
      active_h: round2(activeHours(times, ctx.idleGap)),
      prompts: stats.get('prompts') ?? 0,
      tool_calls: stats.get('tool_calls') ?? 0,
      output: stats.get('output') ?? 0,
      api: stats.get('api_calls') ?? 0,
      first: ctx.clock.hhmm(Math.min(...times)),
      last: ctx.clock.hhmm(Math.max(...times)),
    });
  }

  return {
    window: ctx.window(),
    weeks: outWeeks.filter((w) => w.api || w.prompts),
    daily: daily.filter((d) => d.active_h > 0),
  };
}

export async function run(ctx) {
  const data = await collect(ctx);
  if (data.weeks.length === 0) {
    process.stderr.write(`Нет записей за период. Логи ищутся в ${ctx.root}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(data)}\n`);
  return 0;
}
