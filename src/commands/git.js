/** Коммиты по рабочим неделям — для сверки с логами Claude Code.
 *
 * Автор по умолчанию — `git config user.email` самого репозитория: один человек
 * часто коммитит под разными написаниями имени, поэтому отбор идёт по email.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseRange, workdayWeeks } from '../clock.js';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function defaultEmails(repo) {
  try {
    const email = git(repo, ['config', 'user.email']).trim();
    return email ? [email] : [];
  } catch {
    return [];
  }
}

/** Суммы [файлов, добавлено, удалено] из вывода --shortstat. */
export function parseShortstat(text) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    parts.forEach((token, i) => {
      const n = Number.parseInt(parts[i - 1], 10);
      if (!Number.isFinite(n)) return;
      if (token.startsWith('file')) files += n;
      else if (token.startsWith('insertion')) added += n;
      else if (token.startsWith('deletion')) removed += n;
    });
  }
  return [files, added, removed];
}

/** Коммиты автора за период [from 00:00, to+1 00:00). */
export function rangeStats(clock, repo, emails, from, to) {
  const until = clock.day(parseRange(clock, from, to).end);
  const base = ['log', '--all', `--since=${from} 00:00`, `--until=${until} 00:00`,
    ...emails.map((email) => `--author=${email}`)];
  const shas = new Set(git(repo, [...base, '--pretty=%h']).split('\n').filter(Boolean));
  const [files, added, removed] = parseShortstat(git(repo, [...base, '--shortstat', '--pretty=format:']));
  return { commits: shas.size, files, added, removed };
}

/** Суммарные коммиты по всем репозиториям за период целиком. */
export function collectRange(ctx, repos, emails) {
  const total = { commits: 0, files: 0, added: 0, removed: 0, repos: 0 };
  for (const raw of repos) {
    const repo = path.resolve(expand(raw));
    if (!fs.existsSync(path.join(repo, '.git'))) {
      process.stderr.write(`пропускаю ${repo}: не git-репозиторий\n`);
      continue;
    }
    const who = emails.length ? emails : defaultEmails(repo);
    if (who.length === 0) {
      process.stderr.write(`пропускаю ${repo}: не задан автор и пуст user.email\n`);
      continue;
    }
    try {
      const stat = rangeStats(ctx.clock, repo, who, ctx.from, ctx.to);
      total.commits += stat.commits;
      total.files += stat.files;
      total.added += stat.added;
      total.removed += stat.removed;
      total.repos += 1;
    } catch (err) {
      process.stderr.write(`пропускаю ${repo}: ${err.message.trim().split('\n')[0]}\n`);
    }
  }
  return total.repos ? total : null;
}

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function collect(ctx, repos, emails) {
  const weeks = workdayWeeks(ctx.clock, ctx.start, ctx.end);
  const result = {};

  for (const raw of repos) {
    const repo = path.resolve(expand(raw));
    if (!fs.existsSync(path.join(repo, '.git'))) {
      process.stderr.write(`пропускаю ${repo}: не git-репозиторий\n`);
      continue;
    }
    const who = emails.length ? emails : defaultEmails(repo);
    if (who.length === 0) {
      process.stderr.write(`пропускаю ${repo}: не задан автор и пуст user.email\n`);
      continue;
    }
    const name = path.basename(repo);
    try {
      result[name] = Object.fromEntries(
        weeks.map(([monday, friday]) => [monday, rangeStats(ctx.clock, repo, who, monday, friday)]),
      );
      result[name]._emails = who;
    } catch (err) {
      process.stderr.write(`пропускаю ${repo}: ${err.message.trim().split('\n')[0]}\n`);
    }
  }
  return result;
}

export async function run(ctx, options) {
  const repos = options.repo.length ? options.repo : [process.cwd()];
  const data = collect(ctx, repos, options.email);
  if (Object.keys(data).length === 0) {
    process.stderr.write('Ни одного репозитория обработать не удалось\n');
    return 1;
  }
  process.stdout.write(`${JSON.stringify(data)}\n`);
  return 0;
}
