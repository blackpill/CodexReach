"""Wire-level marker health regressions; no real credentials or public requests."""
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from integrations.hermes.release import smoke, transport
from integrations.hermes.release.cloudflare import CloudflareReadClient
from integrations.hermes.release.config import ReleaseConfig, production_config
from integrations.hermes.release.deploy_tools import runner
from integrations.hermes.release.manifest import digest
from integrations.hermes.release.tickets import sign_ticket


class MarkerHealthTests(unittest.TestCase):
    SHA = 'a' * 40

    def setUp(self):
        self.seen = []
        self.response_sha = self.SHA
        self.force_forbidden = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                fixture.seen.append({
                    'agent': self.headers.get('User-Agent'),
                    'accept': self.headers.get('Accept'),
                    'cache': self.headers.get('Cache-Control'),
                    'authorization': self.headers.get('Authorization'),
                    'path': self.path,
                })
                # Models the observed 1010 behavior, without weakening any real WAF.
                allowed = (self.headers.get('User-Agent') == 'ClassGamesReleaseHealth/1.0'
                           and not fixture.force_forbidden)
                body = (json.dumps({'sha': fixture.response_sha}).encode()
                        if allowed else b'error code: 1010\n')
                self.send_response(200 if allowed else 403)
                self.send_header('Content-Type', 'application/json' if allowed else 'text/plain')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.opener = urllib.request.build_opener(transport.NoRedirect())

        class LocalOnlyOpener:
            def open(_, request, timeout):
                url = urllib.parse.urlsplit(request.full_url)
                fixture.assertEqual(url.scheme, 'https')
                fixture.assertEqual(url.netloc, 'classgames.net')
                fixture.assertEqual(url.path, '/__release.json')
                fixture.assertEqual(request.get_method(), 'GET')
                fixture.assertIsNone(request.get_header('Authorization'))
                local = 'http://127.0.0.1:%s%s?%s' % (
                    fixture.server.server_port, url.path, url.query)
                # Forward actual production Request headers to a real HTTP fixture.
                try:
                    return fixture.opener.open(urllib.request.Request(
                        local, headers=dict(request.header_items()), method='GET'), timeout=timeout)
                except urllib.error.HTTPError as error:
                    # The fixture owns this error response; close its socket before forwarding.
                    error.close()
                    raise

        self.redirect = mock.patch.object(
            transport.urllib.request, 'build_opener', return_value=LocalOnlyOpener())
        self.redirect.start()
        self.page_smoke = mock.patch.object(smoke, 'smoke', return_value=True)
        self.page_smoke.start()

    def tearDown(self):
        self.redirect.stop()
        self.page_smoke.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def assert_marker_contract(self):
        request = self.seen[-1]
        self.assertEqual(request['agent'], 'ClassGamesReleaseHealth/1.0')
        self.assertEqual(request['accept'], 'application/json')
        self.assertEqual(request['cache'], 'no-cache')
        self.assertIsNone(request['authorization'])

    def test_cloud_health_can_read_marker_with_identified_agent(self):
        client = CloudflareReadClient(ReleaseConfig(), 'must-not-be-forwarded')
        try:
            result = client.health(self.SHA)
        except ValueError:
            self.fail('Cloud marker check was blocked: an explicit application agent is required')
        self.assertTrue(result)
        self.assert_marker_contract()
        self.assertEqual(len(self.seen), 1)

    def test_trusted_runner_entrypoint_uses_identified_marker_request(self):
        now = int(time.time())
        key = Ed25519PrivateKey.generate()
        private = key.private_bytes(serialization.Encoding.PEM,
                                    serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption())
        public = key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        ticket = sign_ticket({
            'release_id': 'unit-health', 'operation': 'deploy', 'repository_id': 1223017142,
            'target_sha': self.SHA, 'target_version': None, 'environment': 'production',
            'expected_previous_version': 'unit-version', 'config_digest': digest(production_config()),
            'approved_by': 'ou_unit', 'approved_at': now, 'expires_at': now + 5400,
        }, private)
        with tempfile.TemporaryDirectory() as td:
            event = Path(td) / 'event.json'
            event.write_text(json.dumps({'inputs': {'approval_ticket': ticket}}))
            # Local test-process env only; cannot change repo/cloud production switches.
            env = {
                'CLASSGAMES_PRODUCTION_RELEASE_ENABLED': 'true',
                'RELEASE_PACKAGE': str(Path(td) / 'unused-package'),
                'RELEASE_TARGET_SHA': self.SHA, 'RELEASE_ID': 'unit-health',
                'GITHUB_RUN_ID': '1', 'GITHUB_EVENT_PATH': str(event),
                'RELEASE_PUBLIC_KEY': public.decode(),
                'CLOUDFLARE_API_TOKEN': 'must-not-be-forwarded',
                'RELEASE_CLAIM_URL': 'https://example.invalid/v1/claims',
                'RELEASE_RESULT': str(Path(td) / 'result.json'),
            }

            def observe_health(*args):
                # Exercise the real entrypoint's health callback, never claim/deploy/snapshot.
                try:
                    healthy = args[9](self.SHA)
                except ValueError:
                    self.fail('Runner marker check was blocked: explicit application agent required')
                self.assertTrue(healthy)
                return {'deploy_status': 'deployed', 'health_status': 'healthy'}

            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(runner, 'run_release', side_effect=observe_health), \
                    mock.patch.object(runner.subprocess, 'run', side_effect=AssertionError('No deploy')):
                runner.main()
        self.assert_marker_contract()
        self.assertEqual(len(self.seen), 1)

    def test_wrong_sha_is_not_made_healthy_by_agent_change(self):
        self.response_sha = 'b' * 40
        client = CloudflareReadClient(ReleaseConfig(), 'unused')
        try:
            result = client.health(self.SHA)
        except ValueError:
            self.fail('Marker request must reach SHA validation with its identified agent')
        self.assertFalse(result)
        self.assert_marker_contract()

    def test_forbidden_response_still_fails_once_without_retry_or_spoofing(self):
        self.force_forbidden = True
        with self.assertRaises(ValueError):
            CloudflareReadClient(ReleaseConfig(), 'unused').health(self.SHA)
        self.assertEqual(len(self.seen), 1)
