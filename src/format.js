/** Форматирование текстового вывода. */

/** 1234567 → '1 234 567' (неразрывный пробел не нужен: вывод в терминал). */
export function num(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function fixed(n, digits = 2) {
  return Number(n ?? 0).toFixed(digits);
}

/** Дополняет строку до ширины с учётом того, что кириллица здесь однобайтовая по ширине. */
export function padEnd(s, width) {
  return String(s).padEnd(width);
}

export function padStart(s, width) {
  return String(s).padStart(width);
}

/** Заголовок периода: «Период 2026-07-06 — 2026-07-31 (порог простоя 5 мин, пояс UTC+03:00)». */
export function periodLine(window) {
  return `Период ${window.from} — ${window.to}  (порог простоя ${fixed(window.idle_gap_min, 0)} мин, `
    + `пояс ${window.tz})`;
}
