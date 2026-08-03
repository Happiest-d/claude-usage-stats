/** Полный отчёт одной командой: понедельная агрегация + git + HTML-дашборд. */
import fs from 'node:fs';
import path from 'node:path';

import { build, cleanGit } from '../html.js';
import { collect as collectGit } from './git.js';
import { collect as collectWeekly } from './weekly.js';

export async function run(ctx, options) {
  const weekly = await collectWeekly(ctx);
  if (weekly.weeks.length === 0) {
    process.stderr.write(`Нет записей за период. Логи ищутся в ${ctx.root}\n`);
    return 1;
  }

  const gitData = options.repo.length ? cleanGit(collectGit(ctx, options.repo, options.email)) : null;
  const html = build(weekly, gitData);
  const out = path.resolve(options.out ?? 'dashboard.html');
  fs.writeFileSync(out, html, 'utf8');

  const parts = [`недель ${weekly.weeks.length}`, `дней ${weekly.daily.length}`];
  if (gitData) parts.push(`репозиториев ${Object.keys(gitData).length}`);
  else parts.push('git не подключён (--repo PATH)');
  process.stdout.write(`${out}\n${parts.join(', ')}, ${Math.round(html.length / 1024)} КБ\n`);
  return 0;
}
