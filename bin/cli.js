#!/usr/bin/env node
/** CLI: одна точка входа со всеми командами. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { makeContext, resolvePeriod } from '../src/context.js';
import * as concurrency from '../src/commands/concurrency.js';
import * as gitStats from '../src/commands/git.js';
import * as report from '../src/commands/report.js';
import * as stats from '../src/commands/stats.js';
import * as weekly from '../src/commands/weekly.js';

const COMMANDS = {
  stats: { run: stats.run, help: 'сводка за период: токены, запросы, инструменты, дни' },
  concurrency: { run: concurrency.run, help: 'параллелизм: агент-часы, календарное время, пик' },
  report: { run: report.run, help: 'HTML-дашборд по неделям (пн–пт) в файл' },
  weekly: { run: weekly.run, help: 'понедельная агрегация в JSON (вход для дашборда)' },
  git: { run: gitStats.run, help: 'коммиты по тем же неделям в JSON' },
};

const OPTIONS = {
  from: { type: 'string' },
  to: { type: 'string' },
  'last-week': { type: 'boolean', default: false },
  'this-week': { type: 'boolean', default: false },
  days: { type: 'string' },
  month: { type: 'string' },
  json: { type: 'boolean', default: false },
  repo: { type: 'string', multiple: true, default: [] },
  email: { type: 'string', multiple: true, default: [] },
  out: { type: 'string', short: 'o' },
  tz: { type: 'string' },
  idle: { type: 'string' },
  logs: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const HELP = `claude-usage-stats — статистика работы Claude Code по локальным логам сессий

  claude-usage-stats <команда> [ДАТА-ОТ ДАТА-ДО] [опции]

Команды:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(13)} ${c.help}`).join('\n')}

Период (даты YYYY-MM-DD, обе включительно):
  2026-07-27 2026-07-31   позиционно или через --from / --to
  --last-week             прошлая рабочая неделя, пн–пт
  --this-week             текущая неделя с понедельника по сегодня
  --days N                последние N дней, включая сегодня
  --month [YYYY-MM]       месяц целиком (без значения — текущий)

Опции:
  --json                  выдать JSON вместо текстового отчёта (stats, concurrency)
  --repo PATH             репозиторий для статистики коммитов (можно несколько)
  --email ADDR            email автора коммитов (по умолчанию user.email репозитория)
  -o, --out FILE          куда писать дашборд (по умолчанию dashboard.html)
  --tz ±HH:MM             часовой пояс, в котором режутся сутки (по умолчанию системный)
  --idle N                порог простоя в минутах (по умолчанию 5)
  --logs DIR              каталог логов (по умолчанию ~/.claude/projects)
  -h, --help              эта справка
  -v, --version           версия

Примеры:
  npx github:Happiest-d/claude-usage-stats stats --last-week
  npx github:Happiest-d/claude-usage-stats concurrency 2026-07-20 2026-07-24
  npx github:Happiest-d/claude-usage-stats report --month 2026-07 --repo ~/projects/api -o july.html

Переменные окружения: CLAUDE_STATS_TZ, CLAUDE_STATS_IDLE_MIN, CLAUDE_CONFIG_DIR.
`;

/** `--month` без значения означает текущий месяц; parseArgs так не умеет. */
function fixOptionalMonth(argv) {
  const i = argv.indexOf('--month');
  if (i !== -1 && (i === argv.length - 1 || argv[i + 1].startsWith('-'))) {
    return [...argv.slice(0, i), '--month=', ...argv.slice(i + 1)];
  }
  return argv;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: fixOptionalMonth(argv), options: OPTIONS, allowPositionals: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\nПодсказка: claude-usage-stats --help\n`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (values.help || argv.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const name = positionals[0] in COMMANDS ? positionals.shift() : 'stats';
  const command = COMMANDS[name];

  let ctx;
  try {
    const period = resolvePeriod(values, positionals);
    ctx = makeContext({ ...values, ...period });
  } catch (err) {
    process.stderr.write(`${err.message}\n\nПодсказка: claude-usage-stats --help\n`);
    return 2;
  }

  try {
    return await command.run(ctx, values);
  } catch (err) {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    return 1;
  }
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  process.stderr.write(`Нужен Node.js 20 или новее, запущен ${process.versions.node}\n`);
  process.exit(2);
}

process.exitCode = await main(process.argv.slice(2));
