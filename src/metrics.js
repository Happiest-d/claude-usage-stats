/** Интервалы работы и параллелизм — чистые функции над временем в epoch ms. */
import { isHumanPrompt, isTurnEnd } from './logs.js';

const HOUR_MS = 3_600_000;

/** Порядок событий с совпадающим временем: сначала закрываем ход, потом
 *  открываем новый. Без этого результат зависел бы от порядка обхода файлов —
 *  в логах хватает записей с одинаковой миллисекундой. */
const RANK = { end: 0, prompt: 1, work: 2 };

/** Вид события для `sessionIntervals`. */
export function eventKind(rec) {
  if (isHumanPrompt(rec)) return 'prompt';
  if (isTurnEnd(rec)) return 'end';
  return 'work';
}

/** Интервалы, когда агент сессии реально работал.
 *
 * События — пары [время, вид], где вид: 'prompt' (человек отправил запрос),
 * 'end' (ход завершён), 'work' (всё остальное: ответы, вызовы инструментов,
 * их результаты, события субагентов).
 *
 * Интервал открывается на промпте и закрывается на конце хода; ожидание ввода
 * между ходами не считается работой. Разрыв длиннее `idleGap` закрывает
 * интервал на последнем живом событии — так отсекаются простои и долгое
 * ожидание подтверждения команды.
 */
export function sessionIntervals(events, idleGap) {
  const ordered = [...events].sort((a, b) => a[0] - b[0] || RANK[a[1]] - RANK[b[1]]);
  const out = [];
  let openAt = null;
  let prev = null;

  for (const [t, kind] of ordered) {
    if (openAt !== null && prev !== null && t - prev > idleGap) {
      out.push([openAt, prev]);
      openAt = null;
    }
    if (kind === 'prompt') {
      if (openAt === null) openAt = t;
    } else if (kind === 'end') {
      if (openAt !== null) {
        out.push([openAt, t]);
        openAt = null;
      }
    } else if (openAt === null) {
      openAt = t; // работа без распознанного промпта: resume, хук
    }
    prev = t;
  }
  if (openAt !== null && prev !== null && prev > openAt) out.push([openAt, prev]);
  return out.filter(([a, b]) => b > a);
}

/** Интервалы по разрывам — для субагентов, у которых нет разметки конца хода. */
export function gapIntervals(times, idleGap) {
  const ordered = [...times].sort((a, b) => a - b);
  const out = [];
  let openAt = null;
  let prev = null;

  for (const t of ordered) {
    if (openAt === null) {
      openAt = t;
    } else if (t - prev > idleGap) {
      if (prev > openAt) out.push([openAt, prev]);
      openAt = t;
    }
    prev = t;
  }
  if (openAt !== null && prev !== null && prev > openAt) out.push([openAt, prev]);
  return out;
}

/** Сколько секунд календарного времени работало ровно N агентов.
 *
 * Возвращает { byLevel: Map<уровень, секунды>, peak }. Пересечения схлопываются,
 * поэтому сумма значений — это wall-clock, а не сумма длительностей.
 */
export function sweep(intervals) {
  const points = [];
  for (const [a, b] of intervals) {
    points.push([a, 1], [b, -1]);
  }
  // при совпадении времени закрытие идёт раньше открытия — иначе пик завышается
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const byLevel = new Map();
  let level = 0;
  let peak = 0;
  let prev = null;

  for (const [t, delta] of points) {
    if (prev !== null && level > 0) {
      byLevel.set(level, (byLevel.get(level) ?? 0) + (t - prev) / 1000);
    }
    level += delta;
    if (level > peak) peak = level;
    prev = t;
  }
  return { byLevel, peak };
}

/** Сумма длительностей — «агент-часы», параллельная работа считается кратно. */
export function totalHours(intervals) {
  return intervals.reduce((acc, [a, b]) => acc + (b - a), 0) / HOUR_MS;
}

/** Грубая оценка активности по одной шкале событий: сумма разрывов ≤ idleGap.
 *
 * В отличие от `sessionIntervals`, не отделяет ожидание ввода — годится для
 * подневного среза, где нужна активность вообще, а не занятость агента.
 */
export function activeHours(times, idleGap) {
  const ordered = [...times].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const d = ordered[i] - ordered[i - 1];
    if (d <= idleGap) sum += d;
  }
  return sum / HOUR_MS;
}

/** Сводка по набору интервалов: агент-часы, календарное время, параллелизм, пик. */
export function summarize(intervals) {
  const { byLevel, peak } = sweep(intervals);
  const wall = [...byLevel.values()].reduce((a, b) => a + b, 0) / 3600;
  const total = totalHours(intervals);
  const levels = {};
  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    levels[String(level)] = round2(byLevel.get(level) / 3600);
  }
  const multi = [...byLevel.entries()]
    .filter(([level]) => level >= 2)
    .reduce((acc, [, sec]) => acc + sec, 0) / 3600;

  return {
    agent_hours: round2(total),
    wall_hours: round2(wall),
    concurrency: wall ? round2(total / wall) : 0,
    peak,
    levels,
    multi_hours: round2(multi),
  };
}

export const round2 = (x) => Math.round(x * 100) / 100;
