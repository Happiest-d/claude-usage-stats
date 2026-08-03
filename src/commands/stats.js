/** Сводка использования Claude Code за диапазон дат: токены, запросы,
 *  инструменты, правки файлов и активность по дням.
 *
 *  Занятость агента с учётом параллелизма — в команде `concurrency`,
 *  всё вместе одним блоком — в `summary`.
 */
import { aggregate, counters } from '../aggregate.js';
import { activeHours, round2 } from '../metrics.js';
import { fixed, num, periodLine } from '../format.js';
import { table } from '../table.js';

const asObject = (map) => Object.fromEntries(map ?? []);

/** {ключ: Map} → {ключ: объект}, отсортировано по output по убыванию. */
function byOutput(map) {
  return Object.fromEntries(
    [...(map ?? new Map()).entries()]
      .map(([key, inner]) => [key, asObject(inner)])
      .sort((a, b) => (b[1].output ?? 0) - (a[1].output ?? 0)),
  );
}

export function shape(ctx, agg) {
  const t = counters(agg.totals);
  const days = [...agg.dayTimes.keys()].sort();

  const daily = {};
  for (const day of days) {
    const times = agg.dayTimes.get(day);
    daily[day] = {
      ...asObject(agg.dayStats.get(day)),
      active_h: round2(activeHours(times, ctx.idleGap)),
      sessions: agg.daySessions.get(day)?.size ?? 0,
      first: ctx.clock.hhmm(Math.min(...times)),
      last: ctx.clock.hhmm(Math.max(...times)),
    };
  }

  const activeTotal = [...agg.dayTimes.values()].reduce((acc, times) => acc + activeHours(times, ctx.idleGap), 0);

  return {
    window: ctx.window(),
    totals: {
      ...asObject(agg.totals.get('')),
      files_touched: agg.files.get('')?.size ?? 0,
      sessions: agg.sessions.get('')?.size ?? 0,
      active_h: round2(activeTotal),
    },
    daily,
    models: byOutput(agg.models.get('')),
    projects: byOutput(agg.projects.get('')),
    tools: Object.fromEntries([...(agg.tools.get('') ?? new Map()).entries()].sort((a, b) => b[1] - a[1])),
    _empty: days.length === 0 && t.get('api_calls') === 0,
  };
}

export async function collect(ctx) {
  return shape(ctx, await aggregate(ctx));
}

export function human(report) {
  const t = report.totals;
  const get = (key) => t[key] ?? 0;

  const out = [
    periodLine(report.window),
    '',
    table([
      ['Активных часов', fixed(get('active_h'), 1)],
      ['Промптов', num(get('prompts'))],
      ['Сессий', num(get('sessions'))],
      ['API-запросов', `${num(get('api_calls'))}  (субагенты: ${num(get('sub_api_calls'))})`],
      ['Вызовов инструментов', num(get('tool_calls'))],
      ['Написано токенов', num(get('output'))],
      ['Прочитано токенов', num(get('cache_read') + get('cache_write') + get('input'))],
      ['Файлов затронуто', `${num(get('files_touched'))}  (+${num(get('lines_added'))} / −${num(get('lines_removed'))} строк)`],
    ], { align: ['left', 'right'] }),
    '',
    'По дням:',
    table(
      Object.entries(report.daily).map(([day, d]) => [
        day, fixed(d.active_h), `${d.first}–${d.last}`,
        num(d.prompts ?? 0), num(d.tool_calls ?? 0), num(d.output ?? 0),
      ]),
      { head: ['День', 'Часов', 'Интервал', 'Промптов', 'Инстр.', 'Output'],
        align: ['left', 'right', 'left', 'right', 'right', 'right'] },
    ),
    '',
    'Модели:',
    table(
      Object.entries(report.models).map(([model, v]) => [model, num(v.calls ?? 0), num(v.output ?? 0)]),
      { head: ['Модель', 'Запросов', 'Output'], align: ['left', 'right', 'right'] },
    ),
    '',
    'Инструменты:',
    table(
      Object.entries(report.tools).slice(0, 12).map(([name, n]) => [name, num(n)]),
      { head: ['Инструмент', 'Вызовов'], align: ['left', 'right'] },
    ),
    '',
    'Проекты:',
    table(
      Object.entries(report.projects).slice(0, 10).map(([name, v]) => [name, num(v.calls ?? 0), num(v.output ?? 0)]),
      { head: ['Проект', 'Запросов', 'Output'], align: ['left', 'right', 'right'] },
    ),
  ];
  return out.join('\n');
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
