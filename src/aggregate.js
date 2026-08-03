/** Один проход по логам, из которого строятся все отчёты.
 *
 * Читать логи дорого (секунды на месяц), поэтому команды не ходят по файлам
 * сами: они берут готовые агрегаты отсюда и только раскладывают их по-своему.
 */
import { EDIT_TOOLS, TokenCounter, editedLines, isHumanPrompt, iterRecords, modelOf, toolUses } from './logs.js';
import { eventKind } from './metrics.js';

export const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

/** Возвращает вложенную структуру по ключу, создавая её при первом обращении. */
export function bucket(map, key, make = () => new Map()) {
  let inner = map.get(key);
  if (inner === undefined) {
    inner = make();
    map.set(key, inner);
  }
  return inner;
}

/** Собирает всё, что нужно отчётам, за один проход по логам.
 *
 * `groupOf(rec)` задаёт дополнительную группировку (например по неделям);
 * записи, для которых он вернул null, пропускаются целиком.
 */
export async function aggregate(ctx, groupOf = () => '') {
  const totals = new Map(); // группа -> счётчики
  const tools = new Map(); // группа -> инструмент -> вызовов
  const models = new Map(); // группа -> модель -> {calls, output, ...}
  const projects = new Map(); // группа -> проект -> {calls, output, ...}
  const files = new Map(); // группа -> Set путей
  const sessions = new Map(); // группа -> Set sessionId
  const sessionEvents = new Map(); // группа -> sessionId -> [[время, вид]]
  const agentTimes = new Map(); // группа -> ключ агента -> [время]
  const dayTimes = new Map(); // день -> [время]
  const dayStats = new Map(); // день -> счётчики
  const daySessions = new Map(); // день -> Set sessionId
  const tokens = new TokenCounter();

  for await (const rec of iterRecords(ctx.files(), ctx.start, ctx.end)) {
    const group = groupOf(rec);
    if (group === null) continue;

    const day = ctx.clock.day(rec.t);
    bucket(dayTimes, day, () => []).push(rec.t);
    if (rec.sessionId && !rec.isSubagent) {
      bucket(sessions, group, () => new Set()).add(rec.sessionId);
      bucket(daySessions, day, () => new Set()).add(rec.sessionId);
    }
    if (rec.sessionId) {
      bucket(bucket(sessionEvents, group), rec.sessionId, () => []).push([rec.t, eventKind(rec)]);
      const agentKey = rec.isSubagent ? rec.file : rec.sessionId;
      bucket(bucket(agentTimes, group), agentKey, () => []).push(rec.t);
    }

    if (isHumanPrompt(rec)) {
      bump(bucket(totals, group), 'prompts');
      bump(bucket(dayStats, day), 'prompts');
    }

    for (const [name, input] of toolUses(rec)) {
      bump(bucket(tools, group), name);
      bump(bucket(totals, group), 'tool_calls');
      bump(bucket(dayStats, day), 'tool_calls');
      if (EDIT_TOOLS.has(name)) {
        if (input.file_path) bucket(files, group, () => new Set()).add(input.file_path);
        const [added, removed] = editedLines(name, input);
        bump(bucket(totals, group), 'lines_added', added);
        bump(bucket(totals, group), 'lines_removed', removed);
      }
    }

    const usage = tokens.add(rec);
    if (usage === null) continue;
    const model = modelOf(rec);
    for (const [key, value] of Object.entries(usage)) {
      bump(bucket(totals, group), key, value);
      bump(bucket(dayStats, day), key, value);
      bump(bucket(bucket(models, group), model), key, value);
      bump(bucket(bucket(projects, group), rec.project), key, value);
    }
    bump(bucket(totals, group), 'api_calls');
    bump(bucket(dayStats, day), 'api_calls');
    bump(bucket(bucket(models, group), model), 'calls');
    bump(bucket(bucket(projects, group), rec.project), 'calls');
    if (rec.isSidechain) bump(bucket(totals, group), 'sub_api_calls');
  }

  return { totals, tools, models, projects, files, sessions, sessionEvents, agentTimes, dayTimes, dayStats, daySessions };
}

/** Счётчики группы как объект (нули для незаполненных ключей запрашиваются через get). */
export function counters(map, group = '') {
  const inner = map.get(group) ?? new Map();
  return { get: (key) => inner.get(key) ?? 0, entries: () => inner };
}
