/** Таблицы в рамках для терминала. */

const CHARS = {
  topLeft: '┌', topMid: '┬', topRight: '┐',
  midLeft: '├', midMid: '┼', midRight: '┤',
  botLeft: '└', botMid: '┴', botRight: '┘',
  h: '─', v: '│',
};

const widthOf = (s) => [...String(s)].length;

function line(widths, left, mid, right) {
  return left + widths.map((w) => CHARS.h.repeat(w + 2)).join(mid) + right;
}

function row(cells, widths, align) {
  const padded = cells.map((cell, i) => {
    const text = String(cell ?? '');
    const gap = ' '.repeat(Math.max(0, widths[i] - widthOf(text)));
    return align[i] === 'right' ? ` ${gap}${text} ` : ` ${text}${gap} `;
  });
  return CHARS.v + padded.join(CHARS.v) + CHARS.v;
}

/** Таблица с рамкой. `align` — массив 'left' | 'right' по колонкам.
 *  `head` необязателен: без него таблица идёт без шапки и разделителя. */
export function table(rows, { head = null, align = [] } = {}) {
  const all = head ? [head, ...rows] : rows;
  if (all.length === 0) return '';
  const columns = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...all.map((r) => widthOf(r[i] ?? ''))));
  const alignment = Array.from({ length: columns }, (_, i) => align[i] ?? 'left');

  const out = [line(widths, CHARS.topLeft, CHARS.topMid, CHARS.topRight)];
  if (head) {
    out.push(row(head, widths, alignment), line(widths, CHARS.midLeft, CHARS.midMid, CHARS.midRight));
  }
  for (const r of rows) out.push(row(r, widths, alignment));
  out.push(line(widths, CHARS.botLeft, CHARS.botMid, CHARS.botRight));
  return out.join('\n');
}
