#!/usr/bin/env python3
"""Сводка использования Claude Code за диапазон дат.

    ./stats.py 2026-07-27 2026-07-31            # человекочитаемый отчёт
    ./stats.py 2026-07-27 2026-07-31 --json     # то же в JSON

Считает токены, запросы, инструменты, правки файлов и активность по дням.
Занятость агента с учётом параллелизма — в concurrency.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

import claudelogs as cl


def collect(date_from: str, date_to: str) -> dict:
    start, end = cl.parse_range(date_from, date_to)
    files = cl.find_log_files(since=start)

    totals = defaultdict(int)
    by_day = defaultdict(lambda: defaultdict(int))
    by_model = defaultdict(lambda: defaultdict(int))
    by_project = defaultdict(lambda: defaultdict(int))
    tools = defaultdict(int)
    files_touched: set[str] = set()
    day_times = defaultdict(list)
    sessions = defaultdict(set)
    tokens = cl.TokenCounter()

    for rec in cl.iter_records(files, start, end):
        day = rec.t.strftime('%Y-%m-%d')
        day_times[day].append(rec.t)
        if rec.session_id and not rec.is_subagent:
            sessions[day].add(rec.session_id)

        if cl.is_human_prompt(rec):
            totals['prompts'] += 1
            by_day[day]['prompts'] += 1

        for name, inp in cl.tool_uses(rec):
            tools[name] += 1
            totals['tool_calls'] += 1
            by_day[day]['tool_calls'] += 1
            if name in cl.EDIT_TOOLS:
                if inp.get('file_path'):
                    files_touched.add(inp['file_path'])
                added, removed = cl.edited_lines(name, inp)
                totals['lines_added'] += added
                totals['lines_removed'] += removed

        usage = tokens.add(rec)
        if usage is None:
            continue
        for key, value in usage.items():
            totals[key] += value
            by_day[day][key] += value
            by_model[cl.model_of(rec)][key] += value
            by_project[rec.project][key] += value
        totals['api_calls'] += 1
        by_day[day]['api_calls'] += 1
        by_model[cl.model_of(rec)]['calls'] += 1
        by_project[rec.project]['calls'] += 1
        if rec.is_sidechain:
            totals['sub_api_calls'] += 1

    daily = {}
    for day, times in sorted(day_times.items()):
        daily[day] = {
            **by_day[day],
            'active_h': round(cl.active_hours(times), 2),
            'sessions': len(sessions[day]),
            'first': min(times).strftime('%H:%M'),
            'last': max(times).strftime('%H:%M'),
        }

    return {
        'window': {'from': date_from, 'to': date_to,
                   'idle_gap_min': cl.IDLE_GAP.total_seconds() / 60,
                   'tz': str(cl.TZ)},
        'totals': {**totals,
                   'files_touched': len(files_touched),
                   'sessions': len({s for day in sessions.values() for s in day}),
                   'active_h': round(sum(cl.active_hours(t) for t in day_times.values()), 2)},
        'daily': daily,
        'models': {m: dict(v) for m, v in sorted(by_model.items(), key=lambda kv: -kv[1]['output'])},
        'projects': {p: dict(v) for p, v in sorted(by_project.items(), key=lambda kv: -kv[1]['output'])},
        'tools': dict(sorted(tools.items(), key=lambda kv: -kv[1])),
    }


def human(rep: dict) -> str:
    t = rep['totals']
    lines = [
        f"Период {rep['window']['from']} — {rep['window']['to']}  (порог простоя "
        f"{rep['window']['idle_gap_min']:.0f} мин, пояс {rep['window']['tz']})",
        '',
        f"  активных часов   {t['active_h']:.1f}",
        f"  промптов         {t['prompts']}",
        f"  сессий           {t['sessions']}",
        f"  API-запросов     {t['api_calls']}  (субагенты: {t['sub_api_calls']})",
        f"  инструментов     {t['tool_calls']}",
        f"  output-токенов   {t['output']:,}".replace(',', ' '),
        f"  прочитано        {t['cache_read'] + t['cache_write'] + t['input']:,}".replace(',', ' '),
        f"  файлов затронуто {t['files_touched']}  (+{t['lines_added']} / −{t['lines_removed']} строк)",
        '',
        'По дням:',
    ]
    for day, d in rep['daily'].items():
        lines.append(f"  {day}  {d['active_h']:5.2f} ч  {d['first']}–{d['last']}  "
                     f"промптов {d.get('prompts', 0):3}  инстр. {d.get('tool_calls', 0):5}  "
                     f"output {d.get('output', 0):>9,}".replace(',', ' '))
    lines += ['', 'Модели:']
    for model, v in rep['models'].items():
        lines.append(f"  {model:<32} {v['calls']:5} запросов  output {v['output']:>10,}".replace(',', ' '))
    lines += ['', 'Инструменты:']
    for name, n in list(rep['tools'].items())[:12]:
        lines.append(f"  {name:<32} {n}")
    lines += ['', 'Проекты:']
    for name, v in list(rep['projects'].items())[:10]:
        lines.append(f"  {name:<48} {v['calls']:5} запросов")
    return '\n'.join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('date_from', help='дата начала, YYYY-MM-DD (включительно)')
    ap.add_argument('date_to', help='дата конца, YYYY-MM-DD (включительно)')
    ap.add_argument('--json', action='store_true', help='выдать JSON вместо отчёта')
    args = ap.parse_args()

    report = collect(args.date_from, args.date_to)
    if not report['daily']:
        print(f'Нет записей за период. Логи ищутся в {cl.LOG_ROOT}', file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=1) if args.json else human(report))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
