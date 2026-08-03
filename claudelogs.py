"""Разбор логов сессий Claude Code.

I/O отделён от вычислений: `iter_records` читает файлы, всё остальное — чистые
функции над уже прочитанными записями.

Формат лога: `~/.claude/projects/<проект>/<sessionId>.jsonl`, по строке на запись.
Субагенты пишутся в `<проект>/<sessionId>/subagents/agent-*.jsonl` и наследуют
`sessionId` родителя.
"""
from __future__ import annotations

import glob
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Iterable, Iterator, NamedTuple

def _tz_from_env() -> timezone:
    """Пояс из CLAUDE_STATS_TZ (например '+03:00'), иначе — системный."""
    raw = os.environ.get('CLAUDE_STATS_TZ', '').strip()
    if raw:
        try:
            sign = -1 if raw[0] == '-' else 1
            hh, _, mm = raw.lstrip('+-').partition(':')
            return timezone(sign * timedelta(hours=int(hh), minutes=int(mm or 0)))
        except ValueError:
            pass
    return datetime.now().astimezone().tzinfo


def _log_root() -> str:
    """Каталог логов: CLAUDE_CONFIG_DIR/projects, иначе ~/.claude/projects."""
    cfg = os.environ.get('CLAUDE_CONFIG_DIR')
    base = cfg if cfg else os.path.expanduser('~/.claude')
    return os.path.join(base, 'projects')


TZ = _tz_from_env()
IDLE_GAP = timedelta(minutes=int(os.environ.get('CLAUDE_STATS_IDLE_MIN', '5')))
LOG_ROOT = _log_root()

EDIT_TOOLS = ('Edit', 'Write', 'NotebookEdit')


# ─────────────────────────── чтение (I/O) ───────────────────────────

class Record(NamedTuple):
    """Одна запись лога, приведённая к нужным нам полям."""
    t: datetime
    type: str                # user | assistant | attachment | ...
    session_id: str | None
    request_id: str | None
    uuid: str | None
    is_subagent: bool        # запись из файла субагента
    is_sidechain: bool       # флаг isSidechain в самой записи
    project: str             # имя каталога проекта
    path: str                # путь к файлу лога
    raw: dict


def find_log_files(root: str = LOG_ROOT, since: datetime | None = None) -> list[str]:
    """Пути ко всем jsonl-логам; `since` отсекает файлы по mtime (дешёвый предфильтр)."""
    files = glob.glob(os.path.join(root, '**', '*.jsonl'), recursive=True)
    if since is None:
        return files
    floor = since.timestamp() - 86400        # запас на сутки: mtime грубее содержимого
    return [f for f in files if os.path.getmtime(f) >= floor]


def project_of(path: str) -> str:
    """Имя проекта по пути лога (для субагентов — проект родительской сессии)."""
    parts = path.split(os.sep)
    if 'subagents' in parts:
        i = parts.index('subagents')
        return parts[i - 2] if i >= 2 else parts[i - 1]
    return os.path.basename(os.path.dirname(path))


def iter_records(files: Iterable[str], start: datetime, end: datetime) -> Iterator[Record]:
    """Записи из логов в полуинтервале [start, end), без дубликатов по uuid.

    Дедуп по uuid нужен, потому что одна и та же запись попадает в несколько
    файлов при resume и сжатии контекста.
    """
    seen: set[str] = set()
    for path in files:
        is_sub = f'{os.sep}subagents{os.sep}' in path
        project = project_of(path)
        try:
            fh = open(path, encoding='utf-8', errors='replace')
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"timestamp"' not in line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = raw.get('timestamp')
                if not ts:
                    continue
                try:
                    t = datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(TZ)
                except ValueError:
                    continue
                if not (start <= t < end):
                    continue
                uid = raw.get('uuid')
                if uid:
                    if uid in seen:
                        continue
                    seen.add(uid)
                yield Record(
                    t=t, type=raw.get('type', ''), session_id=raw.get('sessionId'),
                    request_id=raw.get('requestId'), uuid=uid, is_subagent=is_sub,
                    is_sidechain=bool(raw.get('isSidechain')), project=project,
                    path=path, raw=raw,
                )


# ──────────────────── извлечение полей (чистые) ─────────────────────

def is_human_prompt(rec: Record) -> bool:
    """Промпт, набранный человеком (не tool_result и не служебная запись)."""
    if rec.type != 'user' or rec.is_subagent:
        return False
    raw = rec.raw
    return raw.get('origin', {}).get('kind') == 'human' or raw.get('promptSource') == 'typed'


def is_turn_end(rec: Record) -> bool:
    """Ответ, завершающий ход: дальше агент ждёт пользователя."""
    if rec.type != 'assistant' or rec.is_subagent:
        return False
    return (rec.raw.get('message') or {}).get('stop_reason') == 'end_turn'


def model_of(rec: Record) -> str:
    return (rec.raw.get('message') or {}).get('model', 'unknown')


def usage_of(rec: Record) -> dict[str, int] | None:
    """Токены запроса. None, если записи без usage.

    ВАЖНО: одно API-сообщение пишется в лог несколькими строками с общим
    `requestId` и одинаковым usage — считать надо с дедупом, см. `TokenCounter`.
    """
    if rec.type != 'assistant':
        return None
    u = (rec.raw.get('message') or {}).get('usage')
    if not u:
        return None
    return {
        'input': u.get('input_tokens', 0) or 0,
        'output': u.get('output_tokens', 0) or 0,
        'cache_write': u.get('cache_creation_input_tokens', 0) or 0,
        'cache_read': u.get('cache_read_input_tokens', 0) or 0,
    }


def tool_uses(rec: Record) -> list[tuple[str, dict]]:
    """Пары (имя инструмента, вход) из записи ассистента."""
    if rec.type != 'assistant':
        return []
    content = (rec.raw.get('message') or {}).get('content') or []
    return [(c.get('name', '?'), c.get('input') or {})
            for c in content if isinstance(c, dict) and c.get('type') == 'tool_use']


def edited_lines(tool: str, inp: dict) -> tuple[int, int]:
    """(добавлено, удалено) строк по входу Edit/Write. Переписывание одного места
    считается заново — цифра всегда выше git-диффа."""
    if tool == 'Edit':
        return ((inp.get('new_string') or '').count('\n') + 1,
                (inp.get('old_string') or '').count('\n') + 1)
    if tool == 'Write':
        return ((inp.get('content') or '').count('\n') + 1, 0)
    return (0, 0)


class TokenCounter:
    """Складывает токены, пропуская повторы одного `requestId`."""

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def add(self, rec: Record) -> dict[str, int] | None:
        """Возвращает токены записи или None, если это повтор уже учтённого запроса."""
        u = usage_of(rec)
        if u is None:
            return None
        rid = rec.request_id
        if rid:
            if rid in self._seen:
                return None
            self._seen.add(rid)
        return u


# ─────────────── интервалы работы и параллелизм (чистые) ────────────

Interval = tuple[datetime, datetime]


def session_intervals(events: list[tuple[datetime, str]],
                      idle_gap: timedelta = IDLE_GAP) -> list[Interval]:
    """Интервалы, когда агент сессии реально работал.

    События — пары (время, вид), где вид: 'prompt' (человек отправил запрос),
    'end' (ход завершён), 'work' (всё остальное: ответы, вызовы инструментов,
    их результаты, события субагентов).

    Интервал открывается на промпте и закрывается на конце хода; ожидание ввода
    между ходами не считается работой. Разрыв длиннее `idle_gap` закрывает
    интервал на последнем живом событии — так отсекаются простои и долгое
    ожидание подтверждения команды.
    """
    out: list[Interval] = []
    open_at: datetime | None = None
    prev: datetime | None = None
    for t, kind in sorted(events, key=lambda e: e[0]):
        if open_at is not None and prev is not None and t - prev > idle_gap:
            out.append((open_at, prev))
            open_at = None
        if kind == 'prompt':
            if open_at is None:
                open_at = t
        elif kind == 'end':
            if open_at is not None:
                out.append((open_at, t))
                open_at = None
        elif open_at is None:
            open_at = t          # работа без распознанного промпта: resume, хук
        prev = t
    if open_at is not None and prev is not None and prev > open_at:
        out.append((open_at, prev))
    return [(a, b) for a, b in out if b > a]


def gap_intervals(times: list[datetime], idle_gap: timedelta = IDLE_GAP) -> list[Interval]:
    """Интервалы по разрывам — для субагентов, у которых нет разметки конца хода."""
    out: list[Interval] = []
    open_at: datetime | None = None
    prev: datetime | None = None
    for t in sorted(times):
        if open_at is None:
            open_at = t
        elif t - prev > idle_gap:
            if prev > open_at:
                out.append((open_at, prev))
            open_at = t
        prev = t
    if open_at is not None and prev is not None and prev > open_at:
        out.append((open_at, prev))
    return out


def event_kind(rec: Record) -> str:
    """Вид события для `session_intervals`."""
    if is_human_prompt(rec):
        return 'prompt'
    if is_turn_end(rec):
        return 'end'
    return 'work'


def sweep(intervals: list[Interval]) -> tuple[dict[int, float], int]:
    """Сколько секунд календарного времени работало ровно N агентов.

    Возвращает ({уровень: секунды}, пик). Пересечения схлопываются, поэтому
    сумма значений — это wall-clock, а не сумма длительностей.
    """
    points = sorted([(a, 1) for a, _ in intervals] + [(b, -1) for _, b in intervals])
    by_level: dict[int, float] = {}
    level, peak = 0, 0
    prev: datetime | None = None
    for t, delta in points:
        if prev is not None and level > 0:
            by_level[level] = by_level.get(level, 0.0) + (t - prev).total_seconds()
        level += delta
        peak = max(peak, level)
        prev = t
    return by_level, peak


def total_hours(intervals: list[Interval]) -> float:
    """Сумма длительностей — «агент-часы», параллельная работа считается кратно."""
    return sum((b - a).total_seconds() for a, b in intervals) / 3600


def active_hours(times: list[datetime], idle_gap: timedelta = IDLE_GAP) -> float:
    """Грубая оценка активности по одной шкале событий: сумма разрывов ≤ idle_gap.

    В отличие от `session_intervals`, не отделяет ожидание ввода — годится для
    подневного среза, где нужна активность вообще, а не занятость агента.
    """
    ordered = sorted(times)
    return sum(d.total_seconds() for a, b in zip(ordered, ordered[1:])
               if (d := b - a) <= idle_gap) / 3600


# ─────────────────────────── даты ───────────────────────────────────

def parse_range(date_from: str, date_to: str) -> tuple[datetime, datetime]:
    """('2026-07-06', '2026-07-31') → полуинтервал [начало, конец) в TZ, обе даты включительно."""
    start = datetime.strptime(date_from, '%Y-%m-%d').replace(tzinfo=TZ)
    end = datetime.strptime(date_to, '%Y-%m-%d').replace(tzinfo=TZ) + timedelta(days=1)
    return start, end


def week_start(day: datetime) -> str:
    """Понедельник недели, в которую попадает день, в виде 'YYYY-MM-DD'."""
    return (day - timedelta(days=day.weekday())).strftime('%Y-%m-%d')


def workday_weeks(start: datetime, end: datetime) -> list[tuple[str, str]]:
    """Рабочие недели (пн, пт), пересекающие диапазон, обрезанные по его границам."""
    weeks: list[tuple[str, str]] = []
    cursor = start - timedelta(days=start.weekday())
    while cursor < end:
        monday = cursor
        friday = cursor + timedelta(days=4)
        lo = max(monday, start)
        hi = min(friday, end - timedelta(seconds=1))
        if lo <= hi:
            weeks.append((monday.strftime('%Y-%m-%d'), friday.strftime('%Y-%m-%d')))
        cursor += timedelta(days=7)
    return weeks
