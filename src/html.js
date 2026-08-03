/** Сборка HTML-дашборда из понедельных данных (и необязательной статистики git).
 *
 * Страница самодостаточна: данные, стили и скрипт внутри одного файла, внешних
 * запросов нет. Открывается локально в браузере.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(HERE, 'template.html');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function ruDate(iso) {
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/** Заголовок вида «6–31 июля 2026» или «29 июня — 4 июля 2026». */
export function periodTitle(window, weeks) {
  const first = weeks[0].key;
  const last = window.to;
  const y1 = first.slice(0, 4);
  const y2 = last.slice(0, 4);
  if (first.slice(0, 7) === last.slice(0, 7)) {
    return `${Number(first.slice(8))}–${Number(last.slice(8))} ${MONTHS[Number(first.slice(5, 7)) - 1]} ${y1}`;
  }
  if (y1 !== y2) return `${ruDate(first)} ${y1} — ${ruDate(last)} ${y2}`;
  return `${ruDate(first)} — ${ruDate(last)} ${y1}`;
}

/** Дописывает в недели коммиты по всем репозиториям (сумма). */
export function mergeGit(weeks, gitData) {
  for (const week of weeks) {
    let commits = 0;
    let added = 0;
    let removed = 0;
    const perRepo = {};
    if (gitData) {
      for (const [repo, byWeek] of Object.entries(gitData)) {
        const stat = byWeek[week.key];
        if (!stat) continue;
        commits += stat.commits;
        added += stat.added;
        removed += stat.removed;
        if (stat.commits) perRepo[repo] = stat.commits;
      }
    }
    week.commits = commits;
    week.git_added = added;
    week.git_removed = removed;
    week.git_repos = perRepo;
  }
}

/** Убирает служебные поля из данных git_stats перед подстановкой в страницу. */
export function cleanGit(gitData) {
  if (!gitData) return null;
  const out = {};
  for (const [repo, byWeek] of Object.entries(gitData)) {
    if (repo.startsWith('_')) continue;
    out[repo] = Object.fromEntries(Object.entries(byWeek).filter(([key]) => !key.startsWith('_')));
  }
  return Object.keys(out).length ? out : null;
}

export function build(weekly, gitData, template = fs.readFileSync(TEMPLATE_PATH, 'utf8')) {
  const weeks = weekly.weeks;
  mergeGit(weeks, gitData);
  const payload = {
    weeks,
    daily: weekly.daily,
    window: weekly.window,
    title: periodTitle(weekly.window, weeks),
    hasGit: Boolean(gitData),
    idleMin: weekly.window.idle_gap_min ?? 5,
  };
  return template.replace('__DATA__', () => JSON.stringify(payload));
}
