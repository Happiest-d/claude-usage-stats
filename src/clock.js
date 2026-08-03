/** Время и часовой пояс.
 *
 * Пояс фиксированный (смещение в минутах), а не IANA-зона: сутки и недели
 * режутся по одному и тому же смещению на всём диапазоне. Момент времени
 * везде хранится как epoch ms, локальные компоненты получаются сдвигом
 * `ms + offset` и чтением UTC-полей — это избавляет от зависимости от того,
 * в каком поясе запущен процесс.
 */

export const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');

/** Смещение пояса в минутах: CLAUDE_STATS_TZ (например '+03:00'), иначе системное. */
export function offsetFromEnv(env = process.env) {
  const raw = (env.CLAUDE_STATS_TZ || '').trim();
  const m = /^([+-]?)(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  }
  return -new Date().getTimezoneOffset();
}

/** Порог простоя в миллисекундах: CLAUDE_STATS_IDLE_MIN, по умолчанию 5 минут. */
export function idleGapFromEnv(env = process.env) {
  const min = Number.parseInt(env.CLAUDE_STATS_IDLE_MIN ?? '5', 10);
  return (Number.isFinite(min) && min > 0 ? min : 5) * 60_000;
}

/** Набор функций локального времени для заданного смещения. */
export function makeClock(offsetMin) {
  const shift = offsetMin * 60_000;
  const local = (ms) => new Date(ms + shift);

  return {
    offsetMin,
    label: `UTC${offsetMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`,

    /** 'YYYY-MM-DD' локальной даты момента. */
    day: (ms) => local(ms).toISOString().slice(0, 10),

    /** 'HH:MM' локального времени момента. */
    hhmm: (ms) => local(ms).toISOString().slice(11, 16),

    /** День недели: 0 — понедельник, 6 — воскресенье. */
    weekday: (ms) => (local(ms).getUTCDay() + 6) % 7,

    /** Момент локальной полуночи даты 'YYYY-MM-DD'. */
    dayStart(iso) {
      const ms = Date.parse(`${iso}T00:00:00Z`);
      if (Number.isNaN(ms)) throw new Error(`неверная дата: ${iso} (нужен формат YYYY-MM-DD)`);
      return ms - shift;
    },

    /** Понедельник недели, в которую попадает момент, как 'YYYY-MM-DD'. */
    weekStart(ms) {
      const back = (local(ms).getUTCDay() + 6) % 7;
      return this.day(ms - back * DAY_MS);
    },
  };
}

/** ('2026-07-06', '2026-07-31') → полуинтервал [start, end), обе даты включительно. */
export function parseRange(clock, dateFrom, dateTo) {
  const start = clock.dayStart(dateFrom);
  const end = clock.dayStart(dateTo) + DAY_MS;
  if (end <= start) throw new Error(`пустой период: ${dateFrom} — ${dateTo}`);
  return { start, end };
}

/** Рабочие недели (пн, пт), пересекающие диапазон, обрезанные по его границам. */
export function workdayWeeks(clock, start, end) {
  const weeks = [];
  let cursor = start - clock.weekday(start) * DAY_MS;
  while (cursor < end) {
    const friday = cursor + 4 * DAY_MS;
    if (Math.max(cursor, start) <= Math.min(friday, end - 1000)) {
      weeks.push([clock.day(cursor), clock.day(friday)]);
    }
    cursor += 7 * DAY_MS;
  }
  return weeks;
}
