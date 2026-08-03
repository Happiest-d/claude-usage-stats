/** Понедельная агрегация по рабочим дням — данные для дашборда.
 *
 * Диапазон режется на недели пн–пт; суббота и воскресенье не учитываются.
 */
import { parseRange, workdayWeeks } from '../clock.js';
import { aggregate, counters } from '../aggregate.js';
import { intervalsOf } from './concurrency.js';
import { activeHours, sweep, totalHours, round2 } from '../metrics.js';

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

/** Часы по уровням параллелизма и доля времени с ≥2 работающими агентами. */
function levelsOf(byLevel) {
  const levels = {};
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    levels[String(level)] = round2(byLevel.get(level) / 3600);
  }
  const multi = [...byLevel.entries()]
    .filter(([level]) => level >= 2)
    .reduce((acc, [, sec]) => acc + sec, 0) / 3600;
  const wall = [...byLevel.values()].reduce((a, b) => a + b, 0) / 3600;
  return { levels, multi, wall };
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
  const weekOf = (rec) => {
    const key = ctx.clock.weekStart(rec.t);
    const span = spans.get(key);
    return span && span[0] <= rec.t && rec.t < span[1] ? key : null;
  };

  const agg = await aggregate(ctx, weekOf);

  const outWeeks = [];
  for (const [monday, friday] of weeks) {
    const t = counters(agg.totals, monday);
    const [sessionIv, agentIv] = intervalsOf(agg, ctx, monday);
    const { levels, multi, wall } = levelsOf(sweep(sessionIv).byLevel);
    const agentH = totalHours(sessionIv);
    const all = sweep(agentIv);
    const allWall = [...all.byLevel.values()].reduce((a, b) => a + b, 0) / 3600;
    const allHours = totalHours(agentIv);

    const weekTools = agg.tools.get(monday) ?? new Map();
    const grouped = Object.fromEntries(TOP_TOOLS.map((name) => [name, weekTools.get(name) ?? 0]));
    grouped['Прочие'] = [...weekTools.entries()]
      .filter(([name]) => !TOP_TOOLS.includes(name))
      .reduce((acc, [, n]) => acc + n, 0);

    const models = new Map();
    for (const [model, stats] of agg.models.get(monday) ?? new Map()) {
      if (model.startsWith('<')) continue; // <synthetic> — служебные записи без модели
      const name = prettyModel(model);
      models.set(name, (models.get(name) ?? 0) + (stats.get('calls') ?? 0));
    }

    outWeeks.push({
      key: monday,
      label: `${monday.slice(8)}.${monday.slice(5, 7)}–${friday.slice(8)}.${friday.slice(5, 7)}`,
      prompts: t.get('prompts'),
      api: t.get('api_calls'),
      sub_api: t.get('sub_api_calls'),
      tool_calls: t.get('tool_calls'),
      sessions: agg.sessions.get(monday)?.size ?? 0,
      output: t.get('output'),
      input: t.get('input'),
      cache_read: t.get('cache_read'),
      cache_write: t.get('cache_write'),
      files: agg.files.get(monday)?.size ?? 0,
      added: t.get('lines_added'),
      removed: t.get('lines_removed'),
      agent_h: round2(agentH),
      wall_h: round2(wall),
      conc: wall ? round2(agentH / wall) : 0,
      peak_sessions: sweep(sessionIv).peak,
      multi_h: round2(multi),
      levels,
      all_agent_h: round2(allHours),
      all_wall_h: round2(allWall),
      all_conc: allWall ? round2(allHours / allWall) : 0,
      peak_agents: all.peak,
      tools: grouped,
      models: Object.fromEntries([...models.entries()].sort((a, b) => b[1] - a[1])),
    });
  }

  const daily = [];
  for (const day of [...agg.dayTimes.keys()].sort()) {
    const times = agg.dayTimes.get(day);
    const stats = counters(agg.dayStats, day);
    daily.push({
      date: day,
      week: ctx.clock.weekStart(ctx.clock.dayStart(day)),
      active_h: round2(activeHours(times, ctx.idleGap)),
      prompts: stats.get('prompts'),
      tool_calls: stats.get('tool_calls'),
      output: stats.get('output'),
      api: stats.get('api_calls'),
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
