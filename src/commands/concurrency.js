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
import { iterRecords } from '../logs.js';
import { eventKind, gapIntervals, sessionIntervals, summarize } from '../metrics.js';
import { fixed, padStart, periodLine } from '../format.js';

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export async function collect(ctx) {
  const sessionEvents = new Map(); // sessionId -> [[время, вид]]
  const agentTimes = new Map(); // сессия или файл субагента -> [время]

  for await (const rec of iterRecords(ctx.files(), ctx.start, ctx.end)) {
    if (!rec.sessionId) continue;
    push(sessionEvents, rec.sessionId, [rec.t, eventKind(rec)]);
    push(agentTimes, rec.isSubagent ? rec.file : rec.sessionId, rec.t);
  }

  const sessionIv = [...sessionEvents.values()].flatMap((ev) => sessionIntervals(ev, ctx.idleGap));
  const agentIv = [...agentTimes.values()].flatMap((ts) => gapIntervals(ts, ctx.idleGap));

  const byDay = new Map();
  for (const [a, b] of sessionIv) push(byDay, ctx.clock.day(a), [a, b]);

  const dailySessions = {};
  for (const day of [...byDay.keys()].sort()) {
    dailySessions[day] = summarize(byDay.get(day));
  }

  return {
    window: ctx.window(),
    sessions: summarize(sessionIv),
    agents: summarize(agentIv),
    daily_sessions: dailySessions,
  };
}

export function human(report) {
  const lines = [periodLine(report.window)];

  for (const [key, title] of [
    ['sessions', 'ПАРАЛЛЕЛЬНЫЕ СЕССИИ (окна Claude Code)'],
    ['agents', 'ВСЕ АГЕНТЫ (сессии + субагенты)'],
  ]) {
    const s = report[key];
    lines.push(
      '',
      `=== ${title} ===`,
      `  агент-часов         ${fixed(s.agent_hours, 1)}`,
      `  календарное время   ${fixed(s.wall_hours, 1)} ч`,
      `  средний параллелизм ${fixed(s.concurrency)}`,
      `  пик одновременно    ${s.peak}`,
      '  распределение календарного времени:',
    );
    for (const [level, hours] of Object.entries(s.levels)) {
      const share = s.wall_hours ? (hours / s.wall_hours) * 100 : 0;
      lines.push(`    ${padStart(level, 2)} одновременно: ${padStart(fixed(hours), 6)} ч  (${padStart(fixed(share, 1), 5)}%)`);
    }
  }

  lines.push('', '=== по дням (сессии) ===');
  for (const [day, s] of Object.entries(report.daily_sessions)) {
    lines.push(`  ${day}: агент-часов ${padStart(fixed(s.agent_hours), 5)} | календарных `
      + `${padStart(fixed(s.wall_hours), 5)} | ср. ${fixed(s.concurrency)} | пик ${s.peak} | `
      + `≥2 сессий: ${fixed(s.multi_hours)} ч`);
  }
  return lines.join('\n');
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
