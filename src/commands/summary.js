/** Единая сводка за период: работа агента, объём и результат в одном блоке.
 *
 * То же, что плитки наверху дашборда, но текстом: часы и параллелизм из
 * `concurrency`, промпты и токены из `stats`, коммиты из git (нужен --repo).
 */
import { aggregate, counters } from '../aggregate.js';
import { collectRange } from './git.js';
import { intervalsOf } from './concurrency.js';
import { summarize } from '../metrics.js';
import { fixed, num, periodLine } from '../format.js';
import { table } from '../table.js';

/** 11665784 → «11,67 M»: порядок величины важнее точной цифры. */
function compact(n) {
  const ru = (x) => x.toFixed(2).replace('.', ',');
  if (n >= 1e9) return `${ru(n / 1e9)} G`;
  if (n >= 1e6) return `${ru(n / 1e6)} M`;
  if (n >= 1e4) return `${ru(n / 1e3)} k`;
  return num(n);
}

const per = (value, base, unit) => (base ? `${num(value / base)} ${unit}` : '—');

export async function collect(ctx, options) {
  const agg = await aggregate(ctx);
  const t = counters(agg.totals);
  const [sessionIv, agentIv] = intervalsOf(agg, ctx);
  const sessions = summarize(sessionIv);
  const agents = summarize(agentIv);
  const activeDays = agg.dayTimes.size;
  const git = options.repo.length ? collectRange(ctx, options.repo, options.email) : null;

  return {
    window: ctx.window(),
    active_days: activeDays,
    sessions,
    agents,
    totals: {
      prompts: t.get('prompts'),
      sessions: agg.sessions.get('')?.size ?? 0,
      api_calls: t.get('api_calls'),
      sub_api_calls: t.get('sub_api_calls'),
      tool_calls: t.get('tool_calls'),
      output: t.get('output'),
      context: t.get('cache_read') + t.get('cache_write') + t.get('input'),
      files_touched: agg.files.get('')?.size ?? 0,
      lines_added: t.get('lines_added'),
      lines_removed: t.get('lines_removed'),
    },
    git,
  };
}

export function human(report) {
  const { totals: t, sessions: s, agents: a, git } = report;
  const days = report.active_days;

  const rows = [
    ['Часов работы агента', `${fixed(s.agent_hours, 1)} ч`, `сумма по сессиям, дней с работой: ${days}`],
    ['Календарное время', `${fixed(s.wall_hours, 1)} ч`, 'работала хотя бы одна сессия'],
    ['Средний параллелизм', `×${fixed(s.concurrency)}`, `пик ${s.peak} сессий, ${fixed(s.multi_hours, 1)} ч с ≥2`],
    ['С субагентами', `${fixed(a.agent_hours, 1)} ч`, `параллелизм ×${fixed(a.concurrency)}, пик ${a.peak} агентов`],
    ['Промптов', num(t.prompts), per(t.prompts, days, 'в активный день')],
    ['Сессий', num(t.sessions), per(t.sessions, days, 'в активный день')],
    ['Вызовов инструментов', num(t.tool_calls), per(t.tool_calls, t.prompts, 'на промпт')],
    ['API-запросов', num(t.api_calls), `из них субагентами: ${num(t.sub_api_calls)}`],
    ['Написано токенов', num(t.output), `${compact(t.output)} output`],
    ['Прочитано токенов', num(t.context), `${compact(t.context)} контекста`],
    ['Файлов затронуто', num(t.files_touched), `+${num(t.lines_added)} / −${num(t.lines_removed)} строк в Edit/Write`],
  ];

  if (git) {
    rows.push(['Коммитов в git', num(git.commits),
      `+${num(git.added)} / −${num(git.removed)} строк, ${num(git.files)} файлов`]);
  }

  const out = [periodLine(report.window), '', table(rows, { align: ['left', 'right', 'left'] })];
  if (!git) out.push('', 'Коммиты не считались — укажи --repo PATH, чтобы добавить их в сводку.');
  return out.join('\n');
}

export async function run(ctx, options) {
  const report = await collect(ctx, options);
  if (report.totals.api_calls === 0 && report.totals.prompts === 0) {
    process.stderr.write(`Нет записей за период. Логи ищутся в ${ctx.root}\n`);
    return 1;
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 1)}\n` : `${human(report)}\n`);
  return 0;
}
