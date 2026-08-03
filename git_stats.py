#!/usr/bin/env python3
"""Коммиты по рабочим неделям — для сверки с логами Claude Code.

    ./git_stats.py 2026-07-06 2026-07-31 --repo ~/projects/foo --repo ~/pet/bar > git.json

Без --repo берётся текущий каталог. Автор по умолчанию — все адреса, под которыми
`git config user.email` этого репозитория встречается в истории: один человек часто
коммитит под разными написаниями имени, поэтому отбор идёт по email, а не по имени.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import claudelogs as cl


def git(repo: str, args: list[str]) -> str:
    out = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f'git {" ".join(args)} завершился с ошибкой')
    return out.stdout


def default_emails(repo: str) -> list[str]:
    email = git(repo, ['config', 'user.email']).strip()
    return [email] if email else []


def parse_shortstat(text: str) -> tuple[int, int, int]:
    """Суммы (файлов, добавлено, удалено) из вывода --shortstat."""
    files = added = removed = 0
    for line in text.splitlines():
        parts = line.split()
        for i, token in enumerate(parts):
            if token.startswith('file'):
                files += int(parts[i - 1])
            elif token.startswith('insertion'):
                added += int(parts[i - 1])
            elif token.startswith('deletion'):
                removed += int(parts[i - 1])
    return files, added, removed


def week_stats(repo: str, emails: list[str], monday: str, friday: str) -> dict:
    """Коммиты автора за рабочую неделю (пн 00:00 — сб 00:00)."""
    until = cl.parse_range(monday, friday)[1].strftime('%Y-%m-%d')
    base = ['log', '--all', f'--since={monday} 00:00', f'--until={until} 00:00']
    for email in emails:
        base.append(f'--author={email}')
    shas = set(git(repo, [*base, '--pretty=%h']).split())
    files, added, removed = parse_shortstat(git(repo, [*base, '--shortstat', '--pretty=format:']))
    return {'commits': len(shas), 'files': files, 'added': added, 'removed': removed}


def collect(date_from: str, date_to: str, repos: list[str], emails: list[str]) -> dict:
    start, end = cl.parse_range(date_from, date_to)
    weeks = cl.workday_weeks(start, end)
    result: dict[str, dict] = {}
    for repo in repos:
        repo = os.path.abspath(os.path.expanduser(repo))
        if not os.path.isdir(os.path.join(repo, '.git')):
            print(f'пропускаю {repo}: не git-репозиторий', file=sys.stderr)
            continue
        who = emails or default_emails(repo)
        if not who:
            print(f'пропускаю {repo}: не задан автор и пуст user.email', file=sys.stderr)
            continue
        name = os.path.basename(repo)
        result[name] = {monday: week_stats(repo, who, monday, friday) for monday, friday in weeks}
        result[name]['_emails'] = who
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('date_from')
    ap.add_argument('date_to')
    ap.add_argument('--repo', action='append', default=[], help='путь к репозиторию (можно несколько)')
    ap.add_argument('--email', action='append', default=[],
                    help='email автора (можно несколько); по умолчанию user.email репозитория')
    args = ap.parse_args()

    repos = args.repo or [os.getcwd()]
    data = collect(args.date_from, args.date_to, repos, args.email)
    if not data:
        print('Ни одного репозитория обработать не удалось', file=sys.stderr)
        return 1
    print(json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
