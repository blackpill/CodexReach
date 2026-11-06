#!/usr/bin/env python3
"""Collect classgames search analytics without modifying GA4 state."""
import json
import os
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SITE = 'sc-domain:classgames.net'
ENDPOINT = 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aclassgames.net/searchAnalytics/query'
CREDENTIALS = '/root/data-stats-scripts/credentials/ga4-service-account.json'
OUTPUT = Path('/srv/hermes/projects/classgames/metrics/gsc/latest.json')
PAGE_SIZE = 25000
MAX_ROWS = 100000
DIMENSIONS = [('total', []), ('daily', ['date']), ('queries', ['query']), ('pages', ['page']), ('countries', ['country']), ('devices', ['device'])]


def periods(today):
    end = today - timedelta(days=3)
    return [(name, (end - timedelta(days=27 + offset)).isoformat(), (end - timedelta(days=offset)).isoformat()) for name, offset in [('current', 0), ('previous', 28)]]


def query(session, start, end, dimensions):
    rows = []
    aggregation = None
    while True:
        payload = {'startDate': start, 'endDate': end, 'type': 'web', 'dimensions': dimensions, 'rowLimit': PAGE_SIZE, 'startRow': len(rows), 'dataState': 'final'}
        response = session.post(ENDPOINT, json=payload, timeout=45)
        response.raise_for_status()
        value = response.json()
        batch = value.get('rows', [])
        if not isinstance(batch, list): raise ValueError('invalid API rows')
        rows.extend(batch)
        aggregation = value.get('responseAggregationType', aggregation)
        if len(batch) < PAGE_SIZE: break
        if len(rows) >= MAX_ROWS: raise ValueError('API result exceeded pagination safety limit')
    return {'rows': rows, 'responseAggregationType': aggregation}


def fetch(session, today):
    result = {'schema': 'gsc-search-analytics-snapshot-v1', 'project_id': 'classgames', 'site_url': SITE, 'search_type': 'web', 'data_state': 'final', 'captured_at': datetime.now(timezone.utc).isoformat(), 'quality': 'ok', 'note': 'Google may omit anonymized queries or limit rows. Property totals need not equal dimension totals. Empty rows are not missing-value zeroes.', 'periods': {}}
    for name, start, end in periods(today):
        item = {'start_date': start, 'end_date': end}
        for key, dims in DIMENSIONS:
            item[key] = query(session, start, end, dims)
        result['periods'][name] = item
    return result


def run(session, output, today):
    snapshot = fetch(session, today)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=output.parent, prefix='.gsc-', suffix='.tmp')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(snapshot, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, output)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    return snapshot


def main():
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
        creds = service_account.Credentials.from_service_account_file(CREDENTIALS, scopes=['https://www.googleapis.com/auth/webmasters.readonly'])
        today = datetime.now(ZoneInfo('America/Los_Angeles')).date()
        snapshot = run(AuthorizedSession(creds), OUTPUT, today)
        print('GSC success; captured_at=%s; current=%s..%s' % (snapshot['captured_at'], snapshot['periods']['current']['start_date'], snapshot['periods']['current']['end_date']))
        return 0
    except Exception as exc:
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
        print('GSC collection failed: %s; HTTP status=%s' % (type(exc).__name__, status), file=sys.stderr)
        return 1


if __name__ == '__main__': sys.exit(main())
