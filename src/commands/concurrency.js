/** Параллелизм реально работающих агентов Claude Code.
 *
 * «Работает» = от промпта пользователя до ответа, завершающего ход, минус
 * разрывы длиннее порога простоя. Ожидание ввода между ходами не считается.
 *
 * Две метрики:
 *   сессии — сколько окон Claude Code молотили одновременно (субагенты схлопнуты
 *            с родительской сессией: у них общий sessionId);
 *   агенты — то же, но каждый субагент считается отдельно.
 */
import { aggregate } from '../aggregate.js';
import { gapIntervals, sessionIntervals, summarize } from '../metrics.js';
import { fixed, periodLine } from '../format.js';
import { table } from '../table.js';

/** Интервалы работы: [по сессиям, по всем агентам] для группы. */
export function intervalsOf(agg, ctx, group = '') {
  const sessionIv = [...(agg.sessionEvents.get(group) ?? new Map()).values()]
    .flatMap((events) => sessionIntervals(events, ctx.idleGap));
  const agentIv = [...(agg.agentTimes.get(group) ?? new Map()).values()]
    .flatMap((times) => gapIntervals(times, ctx.idleGap));
  return [sessionIv, agentIv];
}

export function shape(ctx, agg) {
  const [sessionIv, agentIv] = intervalsOf(agg, ctx);

  const byDay = new Map();
  for (const [a, b] of sessionIv) {
    const day = ctx.clock.day(a);
    const list = byDay.get(day);
    if (list) list.push([a, b]);
    else byDay.set(day, [[a, b]]);
  }

  const dailySessions = {};
  for (const day of [...byDay.keys()].sort()) dailySessions[day] = summarize(byDay.get(day));

  return {
    window: ctx.window(),
    sessions: summarize(sessionIv),
    agents: summarize(agentIv),
    daily_sessions: dailySessions,
  };
}

export async function collect(ctx) {
  return shape(ctx, await aggregate(ctx));
}

export function human(report) {
  const out = [periodLine(report.window)];

  for (const [key, title] of [
    ['sessions', 'ПАРАЛЛЕЛЬНЫЕ СЕССИИ (окна Claude Code)'],
    ['agents', 'ВСЕ АГЕНТЫ (сессии + субагенты)'],
  ]) {
    const s = report[key];
    out.push(
      '',
      `${title}:`,
      table([
        ['Агент-часов', fixed(s.agent_hours, 1)],
        ['Календарное время', `${fixed(s.wall_hours, 1)} ч`],
        ['Средний параллелизм', `×${fixed(s.concurrency)}`],
        ['Пик одновременно', String(s.peak)],
      ], { align: ['left', 'right'] }),
      table(
        Object.entries(s.levels).map(([level, hours]) => [
          level, `${fixed(hours)} ч`,
          `${fixed(s.wall_hours ? (hours / s.wall_hours) * 100 : 0, 1)}%`,
        ]),
        { head: ['Одновременно', 'Времени', 'Доля'], align: ['right', 'right', 'right'] },
      ),
    );
  }

  out.push(
    '',
    'По дням (сессии):',
    table(
      Object.entries(report.daily_sessions).map(([day, s]) => [
        day, fixed(s.agent_hours), fixed(s.wall_hours), `×${fixed(s.concurrency)}`,
        String(s.peak), `${fixed(s.multi_hours)} ч`,
      ]),
      { head: ['День', 'Агент-ч', 'Календ.', 'Паралл.', 'Пик', '≥2 сессий'],
        align: ['left', 'right', 'right', 'right', 'right', 'right'] },
    ),
  );
  return out.join('\n');
}

export async function run(ctx, options) {
  const report = await collect(ctx);
  if (Object.keys(report.daily_sessions).length === 0) {
    process.stderr.write(`Нет записей за период. Логи ищутся в ${ctx.root}\n`);
    return 1;
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 1)}\n` : `${human(report)}\n`);
  return 0;
}
