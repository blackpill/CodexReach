#!/usr/bin/env python3
"""Provision the permanent operations Base using the existing tenant identity.

Only Python's standard library is required. Run on the Hermes host:
  python3 /srv/hermes/integrations/provision_base.py

An unresolved write is durably journaled and NEVER blindly retried. Subsequent
runs only reconcile it. If the target is still absent, investigate the API log
before an operator clears that journal entry. Keep one manifest on one host;
the advisory lock is local, not a distributed lock. Do not run competing copies.

Official API references:
https://open.feishu.cn/document/server-docs/docs/bitable-v1/app/create
https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table/create
https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table/patch
https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/create
https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create
https://open.feishu.cn/document/server-docs/docs/drive-v1/folder/list

This script does not grant scopes, send messages, create GitHub Issues, run
development, merge PRs, deploy, or modify Hermes settings, SOUL, or cron jobs.
"""
import argparse
from contextlib import contextmanager
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


BASE_NAME = '项目运营中枢'
DEFAULT_MANIFEST = '/srv/hermes/integrations/base-manifest.json'
PROJECTS = (
    {'project_key': 'usmapgames', 'github_repository_id': '1444221313',
     'github_repository_full_name': 'blackpill/usmapgames.com',
     'feishu_chat_id': 'oc_9ef60f6e8069fb46230a30e2bbc17bb4'},
    {'project_key': 'classgames', 'github_repository_id': '1223017142',
     'github_repository_full_name': 'blackpill/classgames.net',
     'feishu_chat_id': 'oc_0e8427180f15b964018e2f899dd66879'},
)
TABLES = {
    'projects': ('项目配置', [('项目标识', 1), ('仓库ID', 1), ('仓库', 1), ('群ID', 1),
                          ('状态', 1), ('人工审核', 7), ('自动合并', 7), ('自动部署', 7), ('更新时间', 5)]),
    'requests': ('需求与交付', [('需求ID', 1), ('项目标识', 1), ('标题', 1), ('来源', 1),
                           ('状态', 1), ('审核状态', 1), ('GitHubIssueURL', 1), ('PRURL', 1),
                           ('验收标准', 1), ('交付摘要', 1), ('阻塞风险', 1), ('创建时间', 5), ('更新时间', 5)]),
    'metrics': ('指标快照', [('快照ID', 1), ('项目标识', 1), ('采集时间', 5),
                         ('指标名', 1), ('数值', 2), ('维度JSON', 1), ('来源', 1)]),
}


class ProvisionError(Exception):
    """Safe-to-display error: no raw API message, request, or credentials."""


class PermissionDenied(ProvisionError):
    pass


class Conflict(ProvisionError):
    pass


class UncertainWrite(ProvisionError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def load_credentials(path='/root/.hermes/.env'):
    result = {}
    try:
        for line in Path(path).read_text().splitlines():
            match = re.match(r'^\s*(?:export\s+)?(FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=(.*)$', line)
            if match:
                parts = shlex.split(match[2], comments=True)
                if len(parts) != 1:
                    raise ProvisionError('Invalid Feishu credential configuration')
                result[match[1]] = parts[0]
    except (OSError, ValueError):
        raise ProvisionError('Cannot read Feishu credential configuration') from None
    if not all(result.get(k) for k in ('FEISHU_APP_ID', 'FEISHU_APP_SECRET')):
        raise ProvisionError('FEISHU_APP_ID / FEISHU_APP_SECRET missing')
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_transport(method, url, headers, payload):
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as stream:
            raw = stream.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
    except (OSError, urllib.error.URLError):
        raise ProvisionError('API transport failure; response unknown') from None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except (ValueError, UnicodeError):
        raise ProvisionError('API returned an unreadable response') from None


class BaseClient:
    def __init__(self, endpoint='https://open.feishu.cn/open-apis', credentials=None,
                 transport=None):
        if endpoint != 'https://open.feishu.cn/open-apis':
            raise ProvisionError('Only the official Feishu endpoint is allowed')
        self.endpoint = endpoint
        self.credentials = credentials if credentials is not None else load_credentials()
        self.transport = transport or http_transport
        self._token = None
        self.scopes = set()

    @staticmethod
    def _check(response):
        code = response.get('code', 0)
        if code != 0 or response.get('error'):
            # Deliberately never surface API msg/error_description or transport text.
            cls = PermissionDenied if code in (20068, 99991672, 99991676, 99991679) else ProvisionError
            raise cls('Feishu API rejected request; code=' + str(code))
        return response

    def authenticate(self):
        try:
            response = self.transport('POST', 'https://accounts.feishu.cn/oauth/v3/token',
                {'Content-Type': 'application/json'},
                {'grant_type': 'client_credentials', 'client_id': self.credentials['FEISHU_APP_ID'],
                 'client_secret': self.credentials['FEISHU_APP_SECRET']})
        except Exception:
            raise ProvisionError('Tenant authentication transport failed') from None
        self._check(response)
        self._token = response.get('access_token')
        if not self._token:
            raise ProvisionError('Tenant authentication returned no access token')
        self.scopes = set(response.get('scope', '').split())
        return self.scopes

    def check_scopes(self):
        self.authenticate()
        if 'bitable:app' not in self.scopes:
            raise PermissionDenied('Missing tenant scope bitable:app; user scopes cannot be used')
        if not self.scopes.intersection({'drive:drive', 'drive:drive:readonly', 'space:document:retrieve'}):
            raise PermissionDenied('Missing tenant discovery scope space:document:retrieve (or drive:drive:readonly)')

    def call(self, method, path, payload=None, query=None):
        if not self._token:
            self.authenticate()
        if not path.startswith(('bitable/v1/apps', 'drive/v1/files')) or '..' in path:
            raise ProvisionError('API path outside provisioning allowlist')
        url = self.endpoint + '/' + path
        if query:
            url += '?' + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        try:
            response = self.transport(method, url,
                {'Authorization': 'Bearer ' + self._token, 'Content-Type': 'application/json'}, payload)
        except Exception:
            raise ProvisionError('Feishu API transport failed; response unknown') from None
        return self._check(response).get('data', {})

    def list_all(self, path, key='items', query=None):
        result, cursor, seen = [], None, set()
        while True:
            data = self.call('GET', path, query=dict(query or {}, page_size=100, page_token=cursor))
            items = data.get(key)
            if not isinstance(items, list):
                raise ProvisionError('Discovery returned no complete item list')
            result.extend(items)
            if data.get('has_more') is False:
                return result
            cursor = data.get('next_page_token') or data.get('page_token')
            if data.get('has_more') is not True or not cursor or cursor in seen:
                raise ProvisionError('Discovery pagination is incomplete')
            seen.add(cursor)

    def discover_bases(self, folder_token=None):
        queue, seen, bases = [folder_token or ''], set(), {}
        while queue:
            folder = queue.pop(0)
            if folder in seen:
                continue
            seen.add(folder)
            for item in self.list_all('drive/v1/files', 'files', {'folder_token': folder or None}):
                if item.get('type') == 'folder':
                    queue.append(item['token'])
                if item.get('type') == 'bitable' and item.get('name') == BASE_NAME:
                    bases[item['token']] = item
        return list(bases.values())


def get_manifest(path=DEFAULT_MANIFEST):
    p = Path(path)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        raise ProvisionError('Manifest is unreadable; refusing to discard durable state') from None
    if not isinstance(data, dict):
        raise ProvisionError('Invalid manifest')
    return data


def atomic_manifest(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(prefix='.base-manifest-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        dfd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextmanager
def manifest_lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Conflict('Another provisioning process holds the manifest lock') from None
        yield
    finally:
        os.close(fd)


def one(items, what):
    if len(items) > 1:
        raise Conflict('Duplicate ' + what + '; manual reconciliation required')
    return items[0] if items else None


class Provisioner:
    def __init__(self, client, path, folder_token=None, base_token=None):
        self.client, self.path = client, path
        self.m = get_manifest(path)
        if self.m.get('base_name', BASE_NAME) != BASE_NAME:
            raise Conflict('Manifest belongs to a different Base')
        if self.m.get('app_id', client.credentials['FEISHU_APP_ID']) != client.credentials['FEISHU_APP_ID']:
            raise Conflict('Manifest belongs to a different application identity')
        if base_token and self.m.get('base_token') not in (None, base_token):
            raise Conflict('Explicit Base conflicts with manifest')
        self.m.update(schema_version=2, integration='hermes_feishu_operations', base_name=BASE_NAME,
                      app_id=client.credentials['FEISHU_APP_ID'], identity='tenant')
        if not isinstance(self.m.get('tables'), dict):
            self.m['tables'] = {}
        self.m.setdefault('pending_writes', {})
        self.folder = folder_token if folder_token is not None else self.m.get('folder_token')
        self.explicit_base = base_token

    def save(self):
        self.m['checked_at'] = now()
        atomic_manifest(self.path, self.m)

    def mutate(self, key, find, method, path, payload, success=None):
        found = find()
        if found is not None:
            self.m['pending_writes'].pop(key, None)
            self.save()
            return found
        if key in self.m['pending_writes']:
            raise UncertainWrite('Unresolved write ' + key + '; reconcile before retrying')
        self.m['pending_writes'][key] = {'started_at': now(), 'method': method, 'path': path}
        self.save()
        try:
            data = self.client.call(method, path, payload)
            if success:
                success(data)
                self.save()
        except ProvisionError:
            # Keep the journal even for API errors: no assumption about commitment.
            raise UncertainWrite('Write ' + key + ' did not return a confirmed result; reconcile before retrying') from None
        found = find()
        if found is None:
            raise UncertainWrite('Write ' + key + ' is not visible yet; run again to reconcile')
        self.m['pending_writes'].pop(key, None)
        self.save()
        return found

    def base(self):
        recovering_create = 'base:create' in self.m['pending_writes']
        candidates = self.client.discover_bases(self.folder)
        candidate = one(candidates, 'Base name')
        token = self.explicit_base or self.m.get('base_token')
        if token and candidate and candidate['token'] != token:
            raise Conflict('Manifest and discovered Base disagree')
        if not token and candidate:
            token = candidate['token']

        def remember(data):
            app = data.get('app', {})
            if not app.get('app_token'):
                raise ProvisionError('Create Base response contains no identifier')
            self.m.update(base_token=app['app_token'], base_url=app.get('url'),
                          default_table_id=app.get('default_table_id'), created_by_integration=True)

        def find():
            known = self.m.get('base_token')
            if known:
                return {'token': known}
            return one(self.client.discover_bases(self.folder), 'Base name')

        if not token:
            found = self.mutate('base:create', find, 'POST', 'bitable/v1/apps',
                                dict(name=BASE_NAME, **({'folder_token': self.folder} if self.folder else {})), remember)
            token = found['token']
        app = self.client.call('GET', 'bitable/v1/apps/' + token).get('app', {})
        if app.get('app_token') != token or app.get('name') != BASE_NAME:
            raise Conflict('Base metadata does not match the permanent operations Base')
        url = app.get('url') or self.m.get('base_url') or (candidate or {}).get('url')
        if not url:
            raise ProvisionError('Base URL unavailable; refusing to guess tenant hostname')
        self.m.update(base_token=token, base_url=url, folder_token=self.folder)
        if app.get('default_table_id'):
            self.m.setdefault('default_table_id', app['default_table_id'])
        if recovering_create and not self.m.get('default_table_id'):
            # GET app does not promise default_table_id. Recover only the sole,
            # empty table of our journaled newly-created Base, not arbitrary data.
            tables = self.client.list_all('bitable/v1/apps/' + token + '/tables')
            if len(tables) == 1:
                tid = tables[0]['table_id']
                records = self.client.list_all('bitable/v1/apps/' + token + '/tables/' + tid + '/records')
                values = [v for r in records for v in r.get('fields', {}).values()]
                if any(not (v is None or v == '' or isinstance(v, (list, dict)) and not v) for v in values):
                    raise Conflict('Recovered Base default table is not empty; refusing to repurpose it')
                self.m['default_table_id'] = tid
                self.m['created_by_integration'] = True
        self.m['pending_writes'].pop('base:create', None)
        self.save()
        return token

    def table(self, token, key, name, schema):
        root = 'bitable/v1/apps/' + token + '/tables'
        def find():
            return one([t for t in self.client.list_all(root) if t.get('name') == name], 'table ' + name)
        existing = find()
        expected = self.m['tables'].get(key, {}).get('table_id')
        if expected and (not existing or existing.get('table_id') != expected):
            raise Conflict('Table identity changed for ' + key)
        if not existing:
            default = self.m.get('default_table_id') if key == 'projects' else None
            if default:
                # Rename the newly-created default table; never delete user data.
                path, method, payload = root + '/' + default, 'PATCH', {'name': name}
            else:
                path, method = root, 'POST'
                payload = {'table': {'name': name, 'default_view_name': '表格',
                           'fields': [{'field_name': n, 'type': t} for n, t in schema]}}
            existing = self.mutate('table:' + key, find, method, path, payload)
        self.m['pending_writes'].pop('table:' + key, None)
        tid = existing['table_id']
        self.m['tables'][key] = {'name': name, 'table_id': tid, 'fields': {}}
        self.save()
        fieldroot = root + '/' + tid + '/fields'
        for index, (field_name, field_type) in enumerate(schema):
            def findfield():
                fields = self.client.list_all(fieldroot)
                match = one([f for f in fields if f.get('field_name') == field_name], 'field ' + field_name)
                if match and match.get('type') != field_type:
                    raise Conflict('Incompatible field type: ' + name + '/' + field_name)
                return match
            found = findfield()
            if found is None:
                primary = None
                if key == 'projects' and tid == self.m.get('default_table_id') and index == 0:
                    primary = one([f for f in self.client.list_all(fieldroot) if f.get('is_primary')], 'primary field')
                path = fieldroot + '/' + primary['field_id'] if primary else fieldroot
                method = 'PUT' if primary else 'POST'
                found = self.mutate('field:' + key + ':' + field_name, findfield, method, path,
                                    {'field_name': field_name, 'type': field_type})
            self.m['pending_writes'].pop('field:' + key + ':' + field_name, None)
            self.m['tables'][key]['fields'][field_name] = found['field_id']
        self.save()

    def register_projects(self, token):
        tid = self.m['tables']['projects']['table_id']
        root = 'bitable/v1/apps/' + token + '/tables/' + tid + '/records'
        identities = {
            p['project_key']: {'仓库ID': p['github_repository_id'],
                               '仓库': p['github_repository_full_name'], '群ID': p['feishu_chat_id']}
            for p in PROJECTS
        }

        def identify(records, project_key):
            identity = identities[project_key]
            match = one([r for r in records if r.get('fields', {}).get('项目标识') == project_key],
                        'project ' + project_key)
            for record in records:
                fields = record.get('fields', {})
                if fields.get('项目标识') != project_key and any(fields.get(k) == v for k, v in identity.items()):
                    raise Conflict('Project repository/chat already belongs to another project')
            if match:
                for field, value in identity.items():
                    if match['fields'].get(field) not in (None, '', value):
                        raise Conflict('Project repository/chat mismatch: ' + project_key)
            return match

        # Preflight every identity before changing either project. A conflict on
        # the second row must not leave the first one partially repaired.
        initial_records = self.client.list_all(root)
        for project_key in identities:
            identify(initial_records, project_key)
        self.m['projects'] = []
        for project in PROJECTS:
            project_key = project['project_key']
            desired = {'项目标识': project_key, **identities[project_key],
                       '人工审核': True, '自动合并': False, '自动部署': False}

            def row():
                return identify(self.client.list_all(root), project_key)

            current = row()
            if current is None or current.get('fields', {}).get('状态') in (None, ''):
                desired['状态'] = '已登记，人工审核'
            fields = dict(desired)
            def matches():
                r = row()
                return r if r and all(r['fields'].get(k) == v for k, v in desired.items()) else None
            path = root if current is None else root + '/' + current['record_id']
            method = 'POST' if current is None else 'PUT'
            # Only write a timestamp when a real change is needed.
            if matches() is None:
                fields['更新时间'] = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
            rec = self.mutate('project:' + project_key, matches, method, path, {'fields': fields})
            self.m['projects'].append(dict(project, record_id=rec['record_id']))
        self.save()

    def run(self):
        self.client.check_scopes()
        self.m['status'] = 'provisioning'
        self.m['tenant_base_scopes'] = ['bitable:app']
        self.save()
        token = self.base()
        for key, (name, schema) in TABLES.items():
            self.table(token, key, name, schema)
        self.register_projects(token)
        if self.m['pending_writes']:
            raise UncertainWrite('Pending writes remain; manual reconciliation required')
        self.m.update(status='ready', policies={'human_review_required': True, 'auto_merge': False,
                      'auto_deploy': False, 'unapproved_development_dispatch': False},
                      verification={'tenant_scope_verified': True, 'discovery_complete': True,
                                    'schemas_read_back': True, 'project_rows_read_back': True,
                                    'verified_at': now()})
        self.save()
        return self.m


def provision(client, manifest_path=DEFAULT_MANIFEST, folder_token=None, base_token=None):
    with manifest_lock(manifest_path):
        return Provisioner(client, manifest_path, folder_token, base_token).run()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', default='/root/.hermes/.env')
    parser.add_argument('--manifest', default=DEFAULT_MANIFEST)
    parser.add_argument('--folder-token', help='Optional app-accessible folder; used for discovery and creation')
    parser.add_argument('--base-token', help='Explicit existing permanent Base; exact name still verified')
    args = parser.parse_args(argv)
    try:
        result = provision(BaseClient(credentials=load_credentials(args.env)), args.manifest,
                           args.folder_token, args.base_token)
    except ProvisionError as exc:
        print(json.dumps({'ok': False, 'error_type': type(exc).__name__, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except Exception:
        # Do not emit tracebacks or raw urllib exceptions in unattended logs.
        print(json.dumps({'ok': False, 'error': 'Unexpected failure; inspect local state without exposing credentials'}), file=sys.stderr)
        return 3
    print(json.dumps({'ok': True, 'status': result['status'], 'base_token': result['base_token'],
                      'base_url': result['base_url'], 'tables': result['tables'],
                      'projects': result['projects']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
