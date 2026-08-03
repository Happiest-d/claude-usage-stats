/** Сводка использования Claude Code за диапазон дат: токены, запросы,
 *  инструменты, правки файлов и активность по дням.
 *
 *  Занятость агента с учётом параллелизма — в команде `concurrency`.
 */
import { activeHours, round2 } from '../metrics.js';
import { EDIT_TOOLS, TokenCounter, editedLines, isHumanPrompt, iterRecords, modelOf, toolUses } from '../logs.js';
import { fixed, num, padEnd, padStart, periodLine } from '../format.js';

const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

function bucket(map, key) {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

const asObject = (map) => Object.fromEntries(map);

export async function collect(ctx) {
  const totals = new Map();
  const byDay = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const tools = new Map();
  const filesTouched = new Set();
  const dayTimes = new Map();
  const sessionsByDay = new Map();
  const tokens = new TokenCounter();

  for await (const rec of iterRecords(ctx.files(), ctx.start, ctx.end)) {
    const day = ctx.clock.day(rec.t);
    if (!dayTimes.has(day)) dayTimes.set(day, []);
    dayTimes.get(day).push(rec.t);
    if (rec.sessionId && !rec.isSubagent) {
      if (!sessionsByDay.has(day)) sessionsByDay.set(day, new Set());
      sessionsByDay.get(day).add(rec.sessionId);
    }

    if (isHumanPrompt(rec)) {
      bump(totals, 'prompts');
      bump(bucket(byDay, day), 'prompts');
    }

    for (const [name, input] of toolUses(rec)) {
      bump(tools, name);
      bump(totals, 'tool_calls');
      bump(bucket(byDay, day), 'tool_calls');
      if (EDIT_TOOLS.has(name)) {
        if (input.file_path) filesTouched.add(input.file_path);
        const [added, removed] = editedLines(name, input);
        bump(totals, 'lines_added', added);
        bump(totals, 'lines_removed', removed);
      }
    }

    const usage = tokens.add(rec);
    if (usage === null) continue;
    const model = modelOf(rec);
    for (const [key, value] of Object.entries(usage)) {
      bump(totals, key, value);
      bump(bucket(byDay, day), key, value);
      bump(bucket(byModel, model), key, value);
      bump(bucket(byProject, rec.project), key, value);
    }
    bump(totals, 'api_calls');
    bump(bucket(byDay, day), 'api_calls');
    bump(bucket(byModel, model), 'calls');
    bump(bucket(byProject, rec.project), 'calls');
    if (rec.isSidechain) bump(totals, 'sub_api_calls');
  }

  const days = [...dayTimes.keys()].sort();
  const daily = {};
  for (const day of days) {
    const times = dayTimes.get(day);
    daily[day] = {
      ...asObject(byDay.get(day) ?? new Map()),
      active_h: round2(activeHours(times, ctx.idleGap)),
      sessions: sessionsByDay.get(day)?.size ?? 0,
      first: ctx.clock.hhmm(Math.min(...times)),
      last: ctx.clock.hhmm(Math.max(...times)),
    };
  }

  const allSessions = new Set();
  for (const set of sessionsByDay.values()) for (const id of set) allSessions.add(id);
  const activeTotal = [...dayTimes.values()].reduce((acc, t) => acc + activeHours(t, ctx.idleGap), 0);

  const byOutput = (map) => Object.fromEntries(
    [...map.entries()]
      .map(([key, inner]) => [key, asObject(inner)])
      .sort((a, b) => (b[1].output ?? 0) - (a[1].output ?? 0)),
  );

  const zero = (key) => totals.get(key) ?? 0;
  return {
    window: ctx.window(),
    totals: {
      ...asObject(totals),
      files_touched: filesTouched.size,
      sessions: allSessions.size,
      active_h: round2(activeTotal),
    },
    daily,
    models: byOutput(byModel),
    projects: byOutput(byProject),
    tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
    _empty: days.length === 0 && zero('api_calls') === 0,
  };
}

export function human(report) {
  const t = report.totals;
  const get = (key) => t[key] ?? 0;
  const lines = [
    periodLine(report.window),
    '',
    `  активных часов   ${fixed(get('active_h'), 1)}`,
    `  промптов         ${get('prompts')}`,
    `  сессий           ${get('sessions')}`,
    `  API-запросов     ${get('api_calls')}  (субагенты: ${get('sub_api_calls')})`,
    `  инструментов     ${get('tool_calls')}`,
    `  output-токенов   ${num(get('output'))}`,
    `  прочитано        ${num(get('cache_read') + get('cache_write') + get('input'))}`,
    `  файлов затронуто ${get('files_touched')}  (+${get('lines_added')} / −${get('lines_removed')} строк)`,
    '',
    'По дням:',
  ];

  for (const [day, d] of Object.entries(report.daily)) {
    lines.push(`  ${day}  ${padStart(fixed(d.active_h), 5)} ч  ${d.first}–${d.last}  `
      + `промптов ${padStart(d.prompts ?? 0, 3)}  инстр. ${padStart(d.tool_calls ?? 0, 5)}  `
      + `output ${padStart(num(d.output ?? 0), 9)}`);
  }

  lines.push('', 'Модели:');
  for (const [model, v] of Object.entries(report.models)) {
    lines.push(`  ${padEnd(model, 32)} ${padStart(v.calls ?? 0, 5)} запросов  output ${padStart(num(v.output ?? 0), 10)}`);
  }

  lines.push('', 'Инструменты:');
  for (const [name, n] of Object.entries(report.tools).slice(0, 12)) {
    lines.push(`  ${padEnd(name, 32)} ${n}`);
  }

  lines.push('', 'Проекты:');
  for (const [name, v] of Object.entries(report.projects).slice(0, 10)) {
    lines.push(`  ${padEnd(name, 48)} ${padStart(v.calls ?? 0, 5)} запросов`);
  }
  return lines.join('\n');
}

export async function run(ctx, options) {
  const report = await collect(ctx);
  const empty = report._empty;
  delete report._empty;
  if (empty) {
    process.stderr.write(`Нет записей за период. Логи ищутся в ${ctx.root}\n`);
    return 1;
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 1)}\n` : `${human(report)}\n`);
  return 0;
}
