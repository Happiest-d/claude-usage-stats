#!/usr/bin/env python3
"""Параллелизм реально работающих агентов Claude Code.

    ./concurrency.py 2026-07-27 2026-07-31
    ./concurrency.py 2026-07-27 2026-07-31 --json

«Работает» = от промпта пользователя до ответа, завершающего ход, минус разрывы
длиннее порога простоя. Ожидание ввода между ходами работой не считается.

Две метрики:
  сессии — сколько окон Claude Code молотили одновременно (субагенты схлопнуты
           с родительской сессией: у них общий sessionId);
  агенты — то же, но каждый субагент считается отдельно.
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

    sess_events = defaultdict(list)     # sessionId -> [(время, вид)]
    agent_times = defaultdict(list)     # сессия или файл субагента -> [время]

    for rec in cl.iter_records(files, start, end):
        if not rec.session_id:
            continue
        sess_events[rec.session_id].append((rec.t, cl.event_kind(rec)))
        agent_times[rec.path if rec.is_subagent else rec.session_id].append(rec.t)

    sess_iv = [iv for ev in sess_events.values() for iv in cl.session_intervals(ev)]
    agent_iv = [iv for ts in agent_times.values() for iv in cl.gap_intervals(ts)]

    def summarize(intervals):
        by_level, peak = cl.sweep(intervals)
        wall = sum(by_level.values()) / 3600
        total = cl.total_hours(intervals)
        return {
            'agent_hours': round(total, 2),
            'wall_hours': round(wall, 2),
            'concurrency': round(total / wall, 2) if wall else 0,
            'peak': peak,
            'levels': {str(k): round(v / 3600, 2) for k, v in sorted(by_level.items())},
            'multi_hours': round(sum(v for k, v in by_level.items() if k >= 2) / 3600, 2),
        }

    by_day = {}
    day_groups = defaultdict(list)
    for a, b in sess_iv:
        day_groups[a.strftime('%Y-%m-%d')].append((a, b))
    for day, ivs in sorted(day_groups.items()):
        by_day[day] = summarize(ivs)

    return {
        'window': {'from': date_from, 'to': date_to,
                   'idle_gap_min': cl.IDLE_GAP.total_seconds() / 60, 'tz': str(cl.TZ)},
        'sessions': summarize(sess_iv),
        'agents': summarize(agent_iv),
        'daily_sessions': by_day,
    }


def human(rep: dict) -> str:
    lines = [f"Период {rep['window']['from']} — {rep['window']['to']}  "
             f"(порог простоя {rep['window']['idle_gap_min']:.0f} мин)"]
    for key, title in (('sessions', 'ПАРАЛЛЕЛЬНЫЕ СЕССИИ (окна Claude Code)'),
                       ('agents', 'ВСЕ АГЕНТЫ (сессии + субагенты)')):
        s = rep[key]
        lines += ['', f'=== {title} ===',
                  f"  агент-часов         {s['agent_hours']:.1f}",
                  f"  календарное время   {s['wall_hours']:.1f} ч",
                  f"  средний параллелизм {s['concurrency']:.2f}",
                  f"  пик одновременно    {s['peak']}",
                  '  распределение календарного времени:']
        for level, hours in s['levels'].items():
            share = hours / s['wall_hours'] * 100 if s['wall_hours'] else 0
            lines.append(f"    {level:>2} одновременно: {hours:6.2f} ч  ({share:5.1f}%)")
    lines += ['', '=== по дням (сессии) ===']
    for day, s in rep['daily_sessions'].items():
        lines.append(f"  {day}: агент-часов {s['agent_hours']:5.2f} | календарных "
                     f"{s['wall_hours']:5.2f} | ср. {s['concurrency']:.2f} | пик {s['peak']} | "
                     f"≥2 сессий: {s['multi_hours']:.2f} ч")
    return '\n'.join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('date_from')
    ap.add_argument('date_to')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    rep = collect(args.date_from, args.date_to)
    if not rep['daily_sessions']:
        print(f'Нет записей за период. Логи ищутся в {cl.LOG_ROOT}', file=sys.stderr)
        return 1
    print(json.dumps(rep, ensure_ascii=False, indent=1) if args.json else human(rep))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
