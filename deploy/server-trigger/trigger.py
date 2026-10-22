#!/usr/bin/env python3
"""Debian timer: dispatch the existing GitHub workflow; never collect locally."""
import datetime as dt
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

API = 'https://api.github.com/repos/liristy/nesc_scanner/actions/workflows/daily-report.yml'
BEIJING = dt.timezone(dt.timedelta(hours=8))


class TriggerError(Exception):
    pass


class GitHub:
    def __init__(self, token):
        self.token = token

    def __call__(self, method, suffix, payload=None):
        request = urllib.request.Request(API + suffix, method=method,
            data=None if payload is None else json.dumps(payload).encode(), headers={
                'Authorization': 'Bearer ' + self.token,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'nesc-report-server-trigger',
            })
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as error:
            # Do not log headers, credentials, or arbitrary remote response bodies.
            raise TriggerError(f'GitHub HTTP {error.code}; inspect permissions/workflow status') from None
        except (urllib.error.URLError, TimeoutError):
            raise TriggerError('GitHub request failed or timed out; delivery may be uncertain') from None


def save_state(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value) + '\n', encoding='utf-8')
    temporary.replace(path)


def trigger(api, state_path, now=None, sleep=time.sleep, attempts=12):
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(BEIJING)
    date = now.date() if now.time() >= dt.time(16, 0) else now.date() - dt.timedelta(days=1)
    trigger_id = f'nesc-server-{date.isoformat()}'
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}

    def find_run():
        runs = api('GET', '/runs?branch=main&event=workflow_dispatch&per_page=100')['workflow_runs']
        return next((run for run in runs if run['display_title'] == trigger_id
            and run['event'] == 'workflow_dispatch' and run['head_branch'] == 'main'), None)

    existing = find_run()
    if existing:
        save_state(state_path, {'trigger_id': trigger_id, 'phase': 'confirmed', 'run_id': existing['id']})
        return existing
    if state.get('trigger_id') != trigger_id:
        # Record before sending. A lost HTTP response must not cause another POST.
        save_state(state_path, {'trigger_id': trigger_id, 'phase': 'attempted'})
        api('POST', '/dispatches', {'ref': 'main', 'inputs': {'trigger_id': trigger_id}})

    for attempt in range(attempts):
        run = find_run()
        if run:
            save_state(state_path, {'trigger_id': trigger_id, 'phase': 'confirmed', 'run_id': run['id']})
            return run
        if attempt + 1 < attempts:
            sleep(5)
    raise TriggerError(f'{trigger_id}: no matching run confirmed; not resending an uncertain dispatch. '
                       'Inspect GitHub Actions and local state before a manual retry.')


def main():
    import fcntl  # Debian only; the pure trigger logic can be tested elsewhere.
    credential_dir = Path(os.environ['CREDENTIALS_DIRECTORY'])
    token = (credential_dir / 'github_token').read_text(encoding='utf-8').strip()
    if not token or '\n' in token or '\r' in token:
        raise TriggerError('Invalid GitHub credential file')
    state_dir = Path(os.environ['STATE_DIRECTORY'])
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / 'trigger.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run = trigger(GitHub(token), state_dir / 'last-trigger.json')
    print(f"GitHub run confirmed: id={run['id']} status={run['status']} "
          f"conclusion={run.get('conclusion')} url={run['html_url']}", flush=True)
    print('This confirms triggering only; collection completion is reported by GitHub Actions.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (TriggerError, OSError, KeyError, ValueError) as error:
        # No secrets or HTTP request objects are included in these error strings.
        print(f'Trigger failed: {error}', flush=True)
        raise SystemExit(1)
