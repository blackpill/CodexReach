"""Offline contract tests. No credentials, SSH, or public API calls."""
import copy
import importlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlparse, parse_qs


class FakeAPI:
    def __init__(self):
        self.scopes = 'bitable:app space:document:retrieve'
        self.files = []
        self.apps = {}
        self.tables = {}
        self.calls = []
        self.uncertain = None
        self.commit_uncertain = False
        self.pagination = False
        self.omit_default_from_metadata = False

    def response(self, data):
        return {'code': 0, 'msg': 'success', 'data': data}

    def __call__(self, method, url, headers, payload):
        p = urlparse(url)
        path = p.path.removeprefix('/open-apis/')
        self.calls.append((method, path, copy.deepcopy(payload)))
        if path == '/oauth/v3/token':
            return {'code': 0, 'access_token': 't-super-private', 'scope': self.scopes}
        if headers.get('Authorization') != 'Bearer t-super-private':
            raise AssertionError('Tenant Authorization required')
        if path == 'drive/v1/files':
            folder = parse_qs(p.query).get('folder_token', [''])[0]
            files = [f for f in self.files if f.get('parent_token', '') == folder]
            if self.pagination and not parse_qs(p.query).get('page_token'):
                return self.response({'files': [], 'has_more': True, 'next_page_token': 'p2'})
            return self.response({'files': files, 'has_more': False})
        if method == 'GET' and parse_qs(p.query).get('page_size') == ['200']:
            return {'code': 99992402, 'msg': 'page_size exceeds table/field limit'}
        if method == 'POST' and path == self.uncertain and not self.commit_uncertain:
            raise TimeoutError('simulated transport failure t-super-private')
        if path == 'bitable/v1/apps' and method == 'POST':
            token = 'base' + str(len(self.apps) + 1)
            app = {'app_token': token, 'name': payload['name'],
                   'url': 'https://example.feishu.cn/base/' + token,
                   'default_table_id': 'default'}
            self.apps[token] = app
            self.files.append({'type': 'bitable', 'name': app['name'], 'token': token,
                               'url': app['url']})
            self.tables[token] = {'default': {'name': '数据表', 'fields': [
                {'field_name': '文本', 'field_id': 'primary', 'type': 1, 'is_primary': True}], 'records': []}}
            if path == self.uncertain:
                raise TimeoutError('simulated lost response')
            return self.response({'app': app})
        parts = path.split('/')
        if parts[:3] != ['bitable', 'v1', 'apps']:
            raise AssertionError((method, path, payload))
        token = parts[3]
        if len(parts) == 4:
            app = copy.deepcopy(self.apps[token])
            if self.omit_default_from_metadata:
                app.pop('default_table_id', None)
            return self.response({'app': app})
        if len(parts) == 5 and method == 'GET':
            return self.response({'items': [dict(table_id=i, name=t['name']) for i, t in self.tables[token].items()], 'has_more': False})
        if len(parts) == 5 and method == 'POST':
            table = payload['table']
            tid = 'tbl' + str(len(self.tables[token]) + 1)
            self.tables[token][tid] = {'name': table['name'], 'fields': [
                dict(f, field_id='fld' + str(i), is_primary=i == 0) for i, f in enumerate(table.get('fields', []))], 'records': []}
            if path == self.uncertain:
                raise TimeoutError('simulated lost table response')
            return self.response({'table_id': tid})
        tid = parts[5]
        table = self.tables[token][tid]
        if len(parts) == 6 and method == 'PATCH':
            table['name'] = payload['name']
            return self.response({})
        if parts[6] == 'fields':
            if method == 'GET':
                return self.response({'items': table['fields'], 'has_more': False})
            if method == 'PUT':
                field = next(f for f in table['fields'] if f['field_id'] == parts[7])
                field.update(payload)
                return self.response({'field': field})
            field = dict(payload, field_id='f' + str(len(table['fields'])))
            table['fields'].append(field)
            return self.response({'field': field})
        if parts[6] == 'records':
            if method == 'GET':
                return self.response({'items': table['records'], 'has_more': False})
            if method == 'PUT':
                rec = next(r for r in table['records'] if r['record_id'] == parts[7])
                rec['fields'].update(payload['fields'])
                return self.response({'record': rec})
            rec = dict(record_id='rec' + str(len(table['records']) + 1), fields=payload['fields'])
            table['records'].append(rec)
            if path == self.uncertain:
                raise TimeoutError('simulated lost record response')
            return self.response({'record': rec})
        raise AssertionError((method, path, payload))


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'base-manifest.json'
        self.api = FakeAPI()

    def module(self):
        try:
            return importlib.import_module('provision_base')
        except ImportError:
            self.fail('provision_base implementation is missing')

    def run_provision(self, **kwargs):
        m = self.module()
        client = m.BaseClient(credentials={'FEISHU_APP_ID': 'cli_test', 'FEISHU_APP_SECRET': 'secret'}, transport=self.api)
        return m.provision(client, self.path, **kwargs)

    def writes(self):
        return [x for x in self.api.calls if x[0] != 'GET' and x[1] != '/oauth/v3/token']

    def ready(self):
        result = self.run_provision()
        self.assertEqual(result['status'], 'ready')
        return result

    def test_provision_is_idempotent_and_registers_two_isolated_projects(self):
        a = self.ready()
        first = len(self.writes())
        b = self.run_provision()
        self.assertEqual(first, len(self.writes()))
        self.assertEqual(a['base_token'], b['base_token'])
        self.assertEqual(set(b['tables']), {'projects', 'requests', 'metrics'})
        self.assertEqual(len(self.api.tables[b['base_token']]), 3)
        tid = b['tables']['projects']['table_id']
        rows = self.api.tables[b['base_token']][tid]['records']
        by_project = {r['fields']['项目标识']: r['fields'] for r in rows}
        self.assertEqual(set(by_project), {'usmapgames', 'classgames'})
        self.assertEqual(by_project['usmapgames']['仓库ID'], '1444221313')
        self.assertEqual(by_project['classgames']['仓库ID'], '1223017142')
        self.assertEqual(by_project['usmapgames'].get('仓库'), 'blackpill/usmapgames.com')
        self.assertEqual(by_project['classgames'].get('仓库'), 'blackpill/classgames.net')
        self.assertEqual(by_project['usmapgames']['群ID'], 'oc_9ef60f6e8069fb46230a30e2bbc17bb4')
        self.assertEqual(by_project['classgames']['群ID'], 'oc_0e8427180f15b964018e2f899dd66879')
        for f in by_project.values():
            self.assertIs(f['人工审核'], True)
            self.assertIs(f['自动合并'], False)
            self.assertIs(f['自动部署'], False)
        self.assertEqual(json.loads(self.path.read_text())['status'], 'ready')
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.path.parent).st_mode & 0o777, 0o700)

    def test_missing_tenant_base_scope_fails_before_remote_write(self):
        self.api.scopes = 'space:document:retrieve'
        with self.assertRaises(self.module().PermissionDenied):
            self.run_provision()
        self.assertEqual(self.writes(), [])

    def test_missing_drive_scope_does_not_attempt_creation(self):
        self.api.scopes = 'bitable:app'
        with self.assertRaises(self.module().PermissionDenied):
            self.run_provision()
        self.assertEqual(self.writes(), [])

    def test_duplicate_exact_base_names_are_not_chosen_arbitrarily(self):
        self.api.files = [{'token': 'one', 'name': '项目运营中枢', 'type': 'bitable'},
                          {'token': 'two', 'name': '项目运营中枢', 'type': 'bitable'}]
        with self.assertRaises(self.module().Conflict):
            self.run_provision()
        self.assertEqual(self.writes(), [])

    def test_drive_pagination_and_nested_folder_prevent_duplicate_creation(self):
        a = self.ready()
        self.path.unlink()
        self.api.files[0]['parent_token'] = 'folder1'
        self.api.files.append({'type': 'folder', 'token': 'folder1', 'name': 'Folder'})
        self.api.pagination = True
        before = len([c for c in self.writes() if c[1] == 'bitable/v1/apps'])
        b = self.run_provision()
        after = len([c for c in self.writes() if c[1] == 'bitable/v1/apps'])
        self.assertEqual(a['base_token'], b['base_token'])
        self.assertEqual(before, after)

    def test_uncertain_create_is_journaled_and_never_blindly_retried(self):
        self.api.uncertain = 'bitable/v1/apps'
        with self.assertRaises(self.module().UncertainWrite):
            self.run_provision()
        before = len(self.writes())
        with self.assertRaises(self.module().UncertainWrite):
            self.run_provision()
        self.assertEqual(before, len(self.writes()))
        self.assertNotEqual(json.loads(self.path.read_text())['status'], 'ready')

    def test_uncertain_committed_create_is_reconciled_without_second_create(self):
        self.api.uncertain = 'bitable/v1/apps'
        self.api.commit_uncertain = True
        # Reconciliation may succeed in the same invocation or the next one.
        try:
            a = self.run_provision()
        except self.module().UncertainWrite:
            a = self.run_provision()
        self.assertEqual(a['status'], 'ready')
        self.assertEqual(len(self.api.apps), 1)

    def test_lost_base_response_without_default_id_still_provisions_exactly_three_tables(self):
        self.api.uncertain = 'bitable/v1/apps'
        self.api.commit_uncertain = True
        self.api.omit_default_from_metadata = True
        try:
            a = self.run_provision()
        except self.module().UncertainWrite:
            a = self.run_provision()
        self.assertEqual(a['status'], 'ready')
        self.assertEqual(len(self.api.tables[a['base_token']]), 3)

    def test_uncertain_committed_table_is_reconciled_without_duplicate(self):
        self.api.uncertain = 'bitable/v1/apps/base1/tables'
        self.api.commit_uncertain = True
        # Both requests and metrics create responses are lost, one per run.
        for _ in range(3):
            try:
                a = self.run_provision()
                break
            except self.module().UncertainWrite:
                continue
        else:
            self.fail('Committed tables did not reconcile')
        self.assertEqual(a['status'], 'ready')
        self.assertEqual(len(self.api.tables[a['base_token']]), 3)

    def test_incomplete_pagination_never_allows_creation(self):
        original = self.api.__call__
        def incomplete(method, url, headers, payload):
            if urlparse(url).path.endswith('/drive/v1/files'):
                return {'code': 0, 'data': {'files': [], 'has_more': True}}
            return original(method, url, headers, payload)
        m = self.module()
        client = m.BaseClient(credentials={'FEISHU_APP_ID': 'cli_test', 'FEISHU_APP_SECRET': 'secret'}, transport=incomplete)
        with self.assertRaises(m.ProvisionError):
            m.provision(client, self.path)
        self.assertEqual(self.writes(), [])

    def test_env_parser_does_not_execute_shell_or_import_user_credentials(self):
        m = self.module()
        env = Path(self.tmp.name) / '.env'
        marker = Path(self.tmp.name) / 'must-not-exist'
        env.write_text('export FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET="$(touch ' + str(marker) + ')"\nUSER_ACCESS_TOKEN=u-ignore\n')
        credentials = m.load_credentials(env)
        self.assertEqual(credentials['FEISHU_APP_ID'], 'cli_test')
        self.assertEqual(set(credentials), {'FEISHU_APP_ID', 'FEISHU_APP_SECRET'})
        self.assertFalse(marker.exists())

    def test_record_create_timeout_cannot_duplicate_registration(self):
        a = self.ready()
        tid = a['tables']['projects']['table_id']
        self.api.tables[a['base_token']][tid]['records'].pop()
        self.api.uncertain = 'bitable/v1/apps/' + a['base_token'] + '/tables/' + tid + '/records'
        self.api.commit_uncertain = True
        try:
            self.run_provision()
        except self.module().UncertainWrite:
            self.run_provision()
        rows = self.api.tables[a['base_token']][tid]['records']
        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r['fields']['项目标识'] for r in rows}), 2)

    def test_cross_project_repository_or_chat_mismatch_is_not_overwritten(self):
        a = self.ready()
        table = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        table['records'][0]['fields']['仓库ID'] = '1223017142'
        before = len(self.writes())
        with self.assertRaises(self.module().Conflict):
            self.run_provision()
        self.assertEqual(before, len(self.writes()))

    def test_changed_unsafe_policy_is_reset_before_ready(self):
        a = self.ready()
        table = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        table['records'][0]['fields']['自动合并'] = True
        self.run_provision()
        self.assertIs(table['records'][0]['fields']['自动合并'], False)

    def test_empty_repository_names_are_filled_without_touching_template_rows_or_requests(self):
        a = self.ready()
        projects = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        for r in projects['records']:
            r['fields'].pop('仓库', None)
        templates = [dict(record_id='template' + str(i), fields={}) for i in range(10)]
        projects['records'].extend(copy.deepcopy(templates))
        requests = self.api.tables[a['base_token']][a['tables']['requests']['table_id']]
        requests['records'] = [{'record_id': 'existing-request', 'fields': {'需求ID': 'request-keep', '状态': '人工审核中'}}]
        request_snapshot = copy.deepcopy(requests)
        before = len(self.writes())
        self.run_provision()
        self.assertEqual(len(projects['records']), 12)
        self.assertEqual(projects['records'][-10:], templates)
        self.assertEqual(requests, request_snapshot)
        by_project = {r['fields'].get('项目标识'): r['fields'] for r in projects['records'] if r['fields']}
        self.assertEqual(by_project['usmapgames'].get('仓库'), 'blackpill/usmapgames.com')
        self.assertEqual(by_project['classgames'].get('仓库'), 'blackpill/classgames.net')
        updates = self.writes()[before:]
        self.assertEqual(len(updates), 2)
        self.assertTrue(all(method == 'PUT' and '/records/' in path for method, path, _ in updates))
        self.run_provision()
        self.assertEqual(len(self.writes()), before + 2)

    def test_conflicting_repository_name_on_second_project_blocks_all_record_writes(self):
        a = self.ready()
        projects = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        projects['records'][0]['fields']['仓库'] = ''
        projects['records'][1]['fields']['仓库'] = 'other-owner/classgames.net'
        before = len(self.writes())
        with self.assertRaises(self.module().Conflict):
            self.run_provision()
        self.assertEqual(len(self.writes()), before)
        self.assertEqual(projects['records'][1]['fields']['仓库'], 'other-owner/classgames.net')

    def test_repository_full_name_already_owned_by_another_row_fails_closed(self):
        a = self.ready()
        projects = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        projects['records'].append({'record_id': 'rogue', 'fields': {'项目标识': 'another-project', '仓库': 'blackpill/usmapgames.com'}})
        before = len(self.writes())
        with self.assertRaises(self.module().Conflict):
            self.run_provision()
        self.assertEqual(len(self.writes()), before)

    def test_existing_business_status_is_preserved_while_safety_policy_is_enforced(self):
        a = self.ready()
        projects = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        for row in projects['records']:
            row['fields'].update({'状态': '用户手写：本周维护中', '自动部署': True})
        self.run_provision()
        for row in projects['records']:
            self.assertEqual(row['fields']['状态'], '用户手写：本周维护中')
            self.assertIs(row['fields']['自动部署'], False)

    def test_empty_existing_status_is_initialized_without_replacing_other_statuses(self):
        a = self.ready()
        projects = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        projects['records'][0]['fields']['状态'] = ''
        projects['records'][1]['fields']['状态'] = '保持用户状态'
        self.run_provision()
        self.assertEqual(projects['records'][0]['fields']['状态'], '已登记，人工审核')
        self.assertEqual(projects['records'][1]['fields']['状态'], '保持用户状态')

    def test_wrong_manifest_base_is_never_modified(self):
        a = self.ready()
        self.api.apps[a['base_token']]['name'] = '旧月度进展'
        before = len(self.writes())
        with self.assertRaises(self.module().Conflict):
            self.run_provision()
        self.assertEqual(before, len(self.writes()))

    def test_duplicate_project_rows_are_not_silently_reused(self):
        a = self.ready()
        table = self.api.tables[a['base_token']][a['tables']['projects']['table_id']]
        table['records'].append(copy.deepcopy(table['records'][0]))
        with self.assertRaises(self.module().Conflict):
            self.run_provision()

    def test_incompatible_existing_field_type_fails_without_coercion(self):
        a = self.ready()
        table = self.api.tables[a['base_token']][a['tables']['metrics']['table_id']]
        next(f for f in table['fields'] if f['field_name'] == '数值')['type'] = 1
        before = len(self.writes())
        with self.assertRaises(self.module().Conflict):
            self.run_provision()
        self.assertEqual(before, len(self.writes()))

    def test_error_messages_never_leak_secret_or_tenant_token(self):
        m = self.module()
        def bad(*args):
            return {'code': 99991672, 'msg': 'secret t-super-private raw credentials'}
        c = m.BaseClient(credentials={'FEISHU_APP_ID': 'cli_test', 'FEISHU_APP_SECRET': 'secret'}, transport=bad)
        with self.assertRaises(m.ProvisionError) as cm:
            c.authenticate()
        self.assertNotIn('secret', str(cm.exception))
        self.assertNotIn('t-super-private', str(cm.exception))

    def test_active_manifest_lock_blocks_all_remote_calls(self):
        import fcntl
        self.path.parent.mkdir(exist_ok=True)
        with open(str(self.path) + '.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(self.module().Conflict):
                self.run_provision()
        self.assertEqual(self.api.calls, [])


if __name__ == '__main__':
    unittest.main()
