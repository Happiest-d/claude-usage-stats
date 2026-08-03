/** Общее окружение запуска: пояс, порог простоя, каталог логов, период. */
import { idleGapFromEnv, makeClock, offsetFromEnv, parseRange, DAY_MS } from './clock.js';
import { findLogFiles, logRoot } from './logs.js';

/** Собирает контекст из переменных окружения и разобранных опций CLI. */
export function makeContext(options = {}, env = process.env) {
  const offset = options.tz !== undefined ? offsetFromEnv({ CLAUDE_STATS_TZ: options.tz }) : offsetFromEnv(env);
  const clock = makeClock(offset);
  const idleGap = options.idle !== undefined
    ? idleGapFromEnv({ CLAUDE_STATS_IDLE_MIN: String(options.idle) })
    : idleGapFromEnv(env);
  const root = options.logs ?? logRoot(env);
  const { start, end } = parseRange(clock, options.from, options.to);

  return {
    clock,
    idleGap,
    root,
    start,
    end,
    from: options.from,
    to: options.to,
    files: () => findLogFiles(root, start),
    window: () => ({
      from: options.from,
      to: options.to,
      idle_gap_min: idleGap / 60_000,
      tz: clock.label,
    }),
  };
}

/** Разрешает период: явные даты или пресет (--last-week, --this-week, --days N, --month). */
export function resolvePeriod(options, positional, env = process.env) {
  const clock = makeClock(options.tz !== undefined
    ? offsetFromEnv({ CLAUDE_STATS_TZ: options.tz })
    : offsetFromEnv(env));
  const today = clock.day(Date.now());
  const shiftDays = (iso, days) => clock.day(clock.dayStart(iso) + days * DAY_MS);

  const [posFrom, posTo] = positional;
  const from = options.from ?? posFrom;
  const to = options.to ?? posTo;
  if (from && to) return { from, to };
  if (from && !to) return { from, to: today };

  if (options['this-week']) {
    return { from: clock.weekStart(Date.now()), to: today };
  }
  if (options['last-week']) {
    const monday = shiftDays(clock.weekStart(Date.now()), -7);
    return { from: monday, to: shiftDays(monday, 4) };
  }
  if (options.days !== undefined) {
    const n = Number.parseInt(options.days, 10);
    if (!Number.isFinite(n) || n < 1) throw new Error('--days ждёт положительное число');
    return { from: shiftDays(today, -(n - 1)), to: today };
  }
  if (options.month !== undefined) {
    const ym = options.month === '' ? today.slice(0, 7) : options.month;
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('--month ждёт YYYY-MM');
    const first = `${ym}-01`;
    const nextMonth = clock.dayStart(first.replace(/-\d{2}$/, '-28')) + 7 * DAY_MS;
    const last = clock.day(clock.dayStart(`${clock.day(nextMonth).slice(0, 7)}-01`) - DAY_MS);
    return { from: first, to: last > today ? today : last };
  }

  throw new Error('не задан период: укажи даты (FROM TO) или пресет --last-week / --this-week / --days N / --month');
}
