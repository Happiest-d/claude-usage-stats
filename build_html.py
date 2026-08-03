#!/usr/bin/env python3
"""Сборка HTML-дашборда из weekly.json (и необязательного git.json).

    ./build_html.py weekly.json --git git.json -o dashboard.html

Страница самодостаточна: данные, стили и скрипт внутри одного файла, внешних
запросов нет. Открывается локально в браузере или публикуется как артефакт.
"""
from __future__ import annotations

import argparse
import json
import os

TEMPLATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'template.html')

MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
          'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']


def ru_date(iso: str) -> str:
    y, m, d = iso.split('-')
    return f'{int(d)} {MONTHS[int(m) - 1]}'


def period_title(window: dict, weeks: list[dict]) -> str:
    """Заголовок вида «6–31 июля 2026» или «29 июня — 4 июля 2026»."""
    first, last = weeks[0]['key'], window['to']
    y1, y2 = first[:4], last[:4]
    if first[:7] == last[:7]:
        return f"{int(first[8:])}–{int(last[8:])} {MONTHS[int(first[5:7]) - 1]} {y1}"
    tail = f'{y1} — {ru_date(last)} {y2}' if y1 != y2 else y1
    return f'{ru_date(first)} — {ru_date(last)} {tail}' if y1 != y2 else f'{ru_date(first)} — {ru_date(last)} {y1}'


def merge_git(weeks: list[dict], git_data: dict | None) -> None:
    """Дописывает в недели коммиты по всем репозиториям (сумма)."""
    for week in weeks:
        commits = added = removed = 0
        per_repo = {}
        if git_data:
            for repo, by_week in git_data.items():
                stat = by_week.get(week['key'])
                if not stat:
                    continue
                commits += stat['commits']
                added += stat['added']
                removed += stat['removed']
                if stat['commits']:
                    per_repo[repo] = stat['commits']
        week['commits'] = commits
        week['git_added'] = added
        week['git_removed'] = removed
        week['git_repos'] = per_repo


def build(weekly: dict, git_data: dict | None) -> str:
    weeks = weekly['weeks']
    merge_git(weeks, git_data)
    payload = {
        'weeks': weeks,
        'daily': weekly['daily'],
        'window': weekly['window'],
        'title': period_title(weekly['window'], weeks),
        'hasGit': bool(git_data),
        'idleMin': weekly['window'].get('idle_gap_min', 5),
    }
    template = open(TEMPLATE_PATH, encoding='utf-8').read()
    return template.replace('__DATA__', json.dumps(payload, ensure_ascii=False, separators=(',', ':')))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('weekly', help='JSON от weekly.py')
    ap.add_argument('--git', help='JSON от git_stats.py (необязательно)')
    ap.add_argument('-o', '--out', default='dashboard.html', help='куда писать (по умолчанию dashboard.html)')
    args = ap.parse_args()

    weekly = json.load(open(args.weekly, encoding='utf-8'))
    git_data = json.load(open(args.git, encoding='utf-8')) if args.git else None
    if git_data:
        git_data = {k: v for k, v in git_data.items() if not k.startswith('_')}
        for repo in git_data.values():
            repo.pop('_emails', None)

    html = build(weekly, git_data)
    with open(args.out, 'w', encoding='utf-8') as fh:
        fh.write(html)
    print(f'{args.out}: {len(html)} байт, недель {len(weekly["weeks"])}, дней {len(weekly["daily"])}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
