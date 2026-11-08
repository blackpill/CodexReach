"""Real HTTP regressions for application identity; no public traffic or credentials."""
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from integrations.hermes.release import transport
from integrations.hermes.release.config import production_config
from integrations.hermes.release.deploy_tools import runner
from integrations.hermes.release.manifest import digest
from integrations.hermes.release.tickets import sign_ticket


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.status = 200
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def handle_request(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                fixture.seen.append((self.command, self.path, self.headers, body))
                # Models the observed edge filter, not authorization approval.
                identified = self.headers.get('User-Agent', '').startswith('ClassGamesRelease')
                status = fixture.status if self.path.startswith('/oidc?') or identified else 403
                self.send_response(status)
                if status == 302:
                    self.send_header('Location', '/must-not-follow')
                response = json.dumps({'value': 'fake-oidc', 'granted': False}).encode()
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            do_GET = handle_request
            do_POST = handle_request

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:%d' % self.server.server_port
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_runner_claim_sends_identified_post_with_original_auth_and_payload(self):
        now = int(time.time())
        key = Ed25519PrivateKey.generate()
        private = key.private_bytes(serialization.Encoding.PEM,
                                    serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption())
        public = key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        ticket = sign_ticket({
            'release_id': 'unit-claim', 'operation': 'deploy', 'repository_id': 1223017142,
            'target_sha': 'a' * 40, 'target_version': None, 'environment': 'production',
            'expected_previous_version': 'unit-version', 'config_digest': digest(production_config()),
            'approved_by': 'ou_unit', 'approved_at': now, 'expires_at': now + 5400,
        }, private)
        opener = urllib.request.build_opener(transport.NoRedirect())
        fixture = self

        class LocalOnlyOpener:
            def open(_, request, timeout):
                if request.get_method() == 'POST':
                    fixture.assertEqual(request.full_url, 'https://claim.invalid/v1/claims')
                    request = urllib.request.Request(
                        fixture.url + '/v1/claims', data=request.data,
                        headers=dict(request.header_items()), method='POST')
                else:
                    fixture.assertTrue(request.full_url.startswith(fixture.url + '/oidc?'))
                try:
                    return opener.open(request, timeout=timeout)
                except urllib.error.HTTPError as error:
                    error.close()
                    raise

        with tempfile.TemporaryDirectory() as td:
            event = Path(td) / 'event.json'
            event.write_text(json.dumps({'inputs': {'approval_ticket': ticket}}))
            env = {
                # Test-process env only; never changes actual production switches.
                'CLASSGAMES_PRODUCTION_RELEASE_ENABLED': 'true',
                'RELEASE_PACKAGE': td, 'RELEASE_TARGET_SHA': 'a' * 40,
                'RELEASE_ID': 'unit-claim', 'GITHUB_RUN_ID': '1',
                'GITHUB_EVENT_PATH': str(event), 'RELEASE_PUBLIC_KEY': public.decode(),
                'CLOUDFLARE_API_TOKEN': 'unused',
                'RELEASE_CLAIM_URL': 'https://claim.invalid/v1/claims',
                'ACTIONS_ID_TOKEN_REQUEST_URL': self.url + '/oidc?test=1',
                'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'fake-request-token',
                'RELEASE_RESULT': str(Path(td) / 'result.json'),
            }

            def exercise_claim(*args):
                # Keep the real entrypoint claim callback and real transport on both hops.
                # Only the HTTPS destination is routed to loopback, never a public endpoint.
                with mock.patch.object(transport.urllib.request, 'build_opener',
                                       return_value=LocalOnlyOpener()):
                    try:
                        result = args[6]({})
                    except ValueError:
                        self.fail('OIDC/claim request blocked: explicit application agent required')
                    self.assertEqual(result, {'value': 'fake-oidc', 'granted': False})
                return {'deploy_status': 'not_attempted', 'health_status': 'not_checked'}

            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(runner, 'run_release', side_effect=exercise_claim), \
                    mock.patch.object(runner.subprocess, 'run', side_effect=AssertionError('No deploy')):
                with self.assertRaises(SystemExit):
                    runner.main()
        self.assertEqual(len(self.seen), 2)
        get, post = self.seen
        self.assertEqual(get[0:2], ('GET', '/oidc?test=1&audience=classgames-release-control'))
        self.assertEqual(get[2]['Authorization'], 'Bearer fake-request-token')
        self.assertEqual(post[0:2], ('POST', '/v1/claims'))
        self.assertEqual(post[2]['Authorization'], 'Bearer fake-oidc')
        self.assertEqual(post[2]['Content-Type'], 'application/json')
        self.assertEqual(json.loads(post[3]), {'release_id': 'unit-claim', 'ticket': ticket})
        for _, _, headers, _ in self.seen:
            self.assertEqual(headers.get_all('User-Agent'), ['ClassGamesReleaseControl/1.0'])

    def test_explicit_lowercase_health_agent_overrides_default_without_duplicate(self):
        transport.request('GET', self.url, headers={'user-agent': 'ClassGamesReleaseHealth/1.0'})
        self.assertEqual(self.seen[0][2].get_all('User-Agent'), ['ClassGamesReleaseHealth/1.0'])

    def test_forbidden_and_redirect_responses_never_retry_or_follow(self):
        opener = urllib.request.build_opener(transport.NoRedirect())

        class ClosingOpener:
            def open(_, request, timeout):
                try:
                    return opener.open(request, timeout=timeout)
                except urllib.error.HTTPError as error:
                    error.close()
                    raise

        patch = mock.patch.object(transport.urllib.request, 'build_opener',
                                  return_value=ClosingOpener())
        patch.start()
        self.addCleanup(patch.stop)
        for status in (403, 302):
            with self.subTest(status=status):
                self.status = status
                before = len(self.seen)
                with self.assertRaisesRegex(ValueError, 'no write retry permitted'):
                    transport.request('POST', self.url + '/v1/claims', {'ticket': 'fake'},
                                      {'Authorization': 'Bearer fake'})
                self.assertEqual(len(self.seen), before + 1)
