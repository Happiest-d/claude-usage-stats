/** Разбор логов сессий Claude Code.
 *
 * I/O отделён от вычислений: `iterRecords` читает файлы, всё остальное —
 * чистые функции над уже прочитанными записями.
 *
 * Формат лога: `~/.claude/projects/<проект>/<sessionId>.jsonl`, по строке на
 * запись. Субагенты пишутся в `<проект>/<sessionId>/subagents/agent-*.jsonl`
 * и наследуют `sessionId` родителя.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { DAY_MS } from './clock.js';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** Каталог логов: CLAUDE_CONFIG_DIR/projects, иначе ~/.claude/projects. */
export function logRoot(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// ─────────────────────────── чтение (I/O) ───────────────────────────

/** Пути ко всем jsonl-логам; `since` отсекает файлы по mtime (дешёвый предфильтр). */
export function findLogFiles(root, since = null) {
  const floor = since === null ? null : since - DAY_MS; // запас на сутки: mtime грубее содержимого
  const found = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // нет доступа или каталог исчез — пропускаем
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (floor === null) {
          found.push(full);
          continue;
        }
        try {
          if (fs.statSync(full).mtimeMs >= floor) found.push(full);
        } catch {
          /* файл исчез между чтением каталога и stat */
        }
      }
    }
  };

  walk(root);
  return found.sort();
}

/** Имя проекта по пути лога (для субагентов — проект родительской сессии). */
export function projectOf(file) {
  const parts = file.split(path.sep);
  const i = parts.indexOf('subagents');
  if (i !== -1) return i >= 2 ? parts[i - 2] : parts[i - 1];
  return path.basename(path.dirname(file));
}

/** Записи из логов в полуинтервале [start, end), без дубликатов по uuid.
 *
 * Дедуп по uuid нужен, потому что одна и та же запись попадает в несколько
 * файлов при resume и сжатии контекста.
 */
export async function* iterRecords(files, start, end) {
  const seen = new Set();
  const subPart = `${path.sep}subagents${path.sep}`;

  for (const file of files) {
    const isSubagent = file.includes(subPart);
    const project = projectOf(file);
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"timestamp"')) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          continue; // оборванная строка в конце файла, который ещё пишется
        }
        if (!raw || typeof raw !== 'object' || !raw.timestamp) continue;
        const t = Date.parse(raw.timestamp);
        if (Number.isNaN(t) || t < start || t >= end) continue;
        const uuid = raw.uuid ?? null;
        if (uuid !== null) {
          if (seen.has(uuid)) continue;
          seen.add(uuid);
        }
        yield {
          t,
          type: raw.type ?? '',
          sessionId: raw.sessionId ?? null,
          requestId: raw.requestId ?? null,
          uuid,
          isSubagent,
          isSidechain: Boolean(raw.isSidechain),
          project,
          file,
          raw,
        };
      }
    } catch {
      /* нечитаемый файл — пропускаем, остальные считаем */
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}

// ──────────────────── извлечение полей (чистые) ─────────────────────

/** Промпт, набранный человеком (не tool_result и не служебная запись). */
export function isHumanPrompt(rec) {
  if (rec.type !== 'user' || rec.isSubagent) return false;
  return rec.raw.origin?.kind === 'human' || rec.raw.promptSource === 'typed';
}

/** Ответ, завершающий ход: дальше агент ждёт пользователя. */
export function isTurnEnd(rec) {
  if (rec.type !== 'assistant' || rec.isSubagent) return false;
  return rec.raw.message?.stop_reason === 'end_turn';
}

export function modelOf(rec) {
  return rec.raw.message?.model ?? 'unknown';
}

/** Токены запроса или null, если у записи нет usage.
 *
 * ВАЖНО: одно API-сообщение пишется в лог несколькими строками с общим
 * `requestId` и одинаковым usage — считать надо с дедупом, см. `TokenCounter`.
 */
export function usageOf(rec) {
  if (rec.type !== 'assistant') return null;
  const u = rec.raw.message?.usage;
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cache_write: u.cache_creation_input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
  };
}

/** Пары [имя инструмента, вход] из записи ассистента. */
export function toolUses(rec) {
  if (rec.type !== 'assistant') return [];
  const content = rec.raw.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && typeof c === 'object' && c.type === 'tool_use')
    .map((c) => [c.name ?? '?', c.input ?? {}]);
}

/** [добавлено, удалено] строк по входу Edit/Write. Переписывание одного места
 *  считается заново — цифра всегда выше git-диффа. */
export function editedLines(tool, input) {
  const lines = (s) => String(s ?? '').split('\n').length;
  if (tool === 'Edit') return [lines(input.new_string), lines(input.old_string)];
  if (tool === 'Write') return [lines(input.content), 0];
  return [0, 0];
}

/** Складывает токены, пропуская повторы одного `requestId`. */
export class TokenCounter {
  #seen = new Set();

  /** Токены записи или null, если это повтор уже учтённого запроса. */
  add(rec) {
    const usage = usageOf(rec);
    if (usage === null) return null;
    if (rec.requestId !== null) {
      if (this.#seen.has(rec.requestId)) return null;
      this.#seen.add(rec.requestId);
    }
    return usage;
  }
}
