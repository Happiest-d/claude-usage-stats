#!/usr/bin/env python3
"""Понедельная агрегация по рабочим дням — данные для дашборда.

    ./weekly.py 2026-07-06 2026-07-31 > weekly.json

Диапазон режется на недели пн–пт; суббота и воскресенье не учитываются.
Результат — JSON для build_html.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta

import claudelogs as cl

TOP_TOOLS = ('Bash', 'Read', 'Edit', 'Write')
MODEL_NAMES = {
    'claude-opus-5': 'Opus 5', 'claude-opus-4-8': 'Opus 4.8', 'claude-opus-4-7': 'Opus 4.7',
    'claude-sonnet-5': 'Sonnet 5', 'claude-fable-5': 'Fable 5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
}


def pretty_model(model: str) -> str:
    return MODEL_NAMES.get(model, model)


def collect(date_from: str, date_to: str) -> dict:
    start, end = cl.parse_range(date_from, date_to)
    weeks = cl.workday_weeks(start, end)
    if not weeks:
        return {'weeks': [], 'daily': []}

    # понедельник -> (начало, конец) рабочей недели
    spans = {}
    for monday, friday in weeks:
        lo = cl.parse_range(monday, friday)[0]
        hi = cl.parse_range(monday, friday)[1]
        spans[monday] = (max(lo, start), min(hi, end))

    def week_of(t: datetime) -> str | None:
        key = cl.week_start(t)
        span = spans.get(key)
        return key if span and span[0] <= t < span[1] else None

    blank = lambda: defaultdict(int)
    totals = defaultdict(blank)
    tools = defaultdict(blank)
    models = defaultdict(lambda: defaultdict(int))
    files = defaultdict(set)
    sessions = defaultdict(set)
    sess_events = defaultdict(list)      # (неделя, sessionId) -> [(время, вид)]
    agent_times = defaultdict(list)      # (неделя, ключ агента) -> [время]
    day_times = defaultdict(list)
    day_stats = defaultdict(blank)
    tokens = cl.TokenCounter()

    for rec in cl.iter_records(cl.find_log_files(since=start), start, end):
        week = week_of(rec.t)
        if week is None:
            continue
        day = rec.t.strftime('%Y-%m-%d')
        day_times[day].append(rec.t)
        if rec.session_id and not rec.is_subagent:
            sessions[week].add(rec.session_id)
        if rec.session_id:
            sess_events[(week, rec.session_id)].append((rec.t, cl.event_kind(rec)))
            agent_times[(week, rec.path if rec.is_subagent else rec.session_id)].append(rec.t)

        if cl.is_human_prompt(rec):
            totals[week]['prompts'] += 1
            day_stats[day]['prompts'] += 1

        for name, inp in cl.tool_uses(rec):
            tools[week][name] += 1
            totals[week]['tool_calls'] += 1
            day_stats[day]['tool_calls'] += 1
            if name in cl.EDIT_TOOLS:
                if inp.get('file_path'):
                    files[week].add(inp['file_path'])
                added, removed = cl.edited_lines(name, inp)
                totals[week]['lines_added'] += added
                totals[week]['lines_removed'] += removed

        usage = tokens.add(rec)
        if usage is None:
            continue
        for key, value in usage.items():
            totals[week][key] += value
            day_stats[day][key] += value
        totals[week]['api_calls'] += 1
        day_stats[day]['api_calls'] += 1
        model = cl.model_of(rec)
        if not model.startswith('<'):        # <synthetic> — служебные записи без модели
            models[week][pretty_model(model)] += 1
        if rec.is_sidechain:
            totals[week]['sub_api_calls'] += 1

    sess_iv = defaultdict(list)
    agent_iv = defaultdict(list)
    for (week, _), events in sess_events.items():
        sess_iv[week] += cl.session_intervals(events)
    for (week, _), times in agent_times.items():
        agent_iv[week] += cl.gap_intervals(times)

    out_weeks = []
    for monday, friday in weeks:
        t = totals[monday]
        by_level, peak = cl.sweep(sess_iv[monday])
        wall = sum(by_level.values()) / 3600
        agent_h = cl.total_hours(sess_iv[monday])
        a_levels, a_peak = cl.sweep(agent_iv[monday])
        a_wall = sum(a_levels.values()) / 3600
        a_hours = cl.total_hours(agent_iv[monday])
        grouped = {name: tools[monday].get(name, 0) for name in TOP_TOOLS}
        grouped['Прочие'] = sum(v for k, v in tools[monday].items() if k not in TOP_TOOLS)
        out_weeks.append({
            'key': monday,
            'label': f"{monday[8:]}.{monday[5:7]}–{friday[8:]}.{friday[5:7]}",
            'prompts': t['prompts'], 'api': t['api_calls'], 'sub_api': t['sub_api_calls'],
            'tool_calls': t['tool_calls'], 'sessions': len(sessions[monday]),
            'output': t['output'], 'input': t['input'],
            'cache_read': t['cache_read'], 'cache_write': t['cache_write'],
            'files': len(files[monday]), 'added': t['lines_added'], 'removed': t['lines_removed'],
            'agent_h': round(agent_h, 2), 'wall_h': round(wall, 2),
            'conc': round(agent_h / wall, 2) if wall else 0, 'peak_sessions': peak,
            'multi_h': round(sum(v for k, v in by_level.items() if k >= 2) / 3600, 2),
            'levels': {str(k): round(v / 3600, 2) for k, v in sorted(by_level.items())},
            'all_agent_h': round(a_hours, 2), 'all_wall_h': round(a_wall, 2),
            'all_conc': round(a_hours / a_wall, 2) if a_wall else 0, 'peak_agents': a_peak,
            'tools': grouped,
            'models': dict(sorted(models[monday].items(), key=lambda kv: -kv[1])),
        })

    daily = []
    for day, times in sorted(day_times.items()):
        week = cl.week_start(datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=cl.TZ))
        daily.append({
            'date': day, 'week': week,
            'active_h': round(cl.active_hours(times), 2),
            'prompts': day_stats[day]['prompts'], 'tool_calls': day_stats[day]['tool_calls'],
            'output': day_stats[day]['output'], 'api': day_stats[day]['api_calls'],
            'first': min(times).strftime('%H:%M'), 'last': max(times).strftime('%H:%M'),
        })

    return {'window': {'from': date_from, 'to': date_to, 'tz': str(cl.TZ),
                       'idle_gap_min': cl.IDLE_GAP.total_seconds() / 60},
            'weeks': [w for w in out_weeks if w['api'] or w['prompts']],
            'daily': [d for d in daily if d['active_h'] > 0]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('date_from')
    ap.add_argument('date_to')
    args = ap.parse_args()

    data = collect(args.date_from, args.date_to)
    if not data['weeks']:
        print(f'Нет записей за период. Логи ищутся в {cl.LOG_ROOT}', file=sys.stderr)
        return 1
    print(json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
