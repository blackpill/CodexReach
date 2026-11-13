import tempfile
import unittest
from pathlib import Path

from .manifest import digest, prepare_manifest
from .reconcile import _reconcile
from .test_core import A, B, SHA
from .test_deploy_tools import package
from . import test_review_regressions as fixtures


class VerifiedRecoveryTests(unittest.TestCase):
    def test_only_bound_claimed_usmapgames_deployment_with_fresh_health_can_close(self):
        for scenario in ('verified', 'automatic_poll', 'unhealthy', 'bad_digest', 'wrong_version',
                         'wrong_deployment', 'drift_during_health', 'unclaimed',
                         'wrong_attempt', 'other_site', 'rollback', 'not_deployed'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                target = B if scenario == 'other_site' else A
                c, _ = fixtures.RegressionTests().setup_controller(root / 'db', target)
                self.addCleanup(c.store.close)
                m = prepare_manifest(c.config, c.gh, c.cf, 100)
                (root / 'package').mkdir()
                artifact = package(root / 'package', target)
                version = '22222222-2222-4222-8222-222222222222'
                deployment = '33333333-3333-4333-8333-333333333333'
                if scenario == 'rollback':
                    from .manifest import rollback_artifact_manifest
                    m.update(operation='rollback', workflow_sha=SHA, target_version=version)
                    artifact = rollback_artifact_manifest(target, SHA, version)
                rid = m['release_id']
                c.store.prepare(m)
                c.store.approve_for_dispatch(rid, 'om_test', 'ou_owner', 101)
                c.store.transition(rid, 'DISPATCH_UNCERTAIN', 'DISPATCHED', {'run_id': '7'})
                if scenario != 'unclaimed':
                    c.store.claim(rid, '7', 1, 102)
                    c.store.transition(rid, 'DEPLOYING', 'DEPLOY_UNCERTAIN', {})
                c.gh.run = lambda _: {
                    'id': 7, 'head_sha': SHA, 'event': 'workflow_dispatch',
                    'path': '.github/workflows/deploy-production.yml',
                    'run_attempt': 2 if scenario == 'wrong_attempt' else 1,
                    'status': 'completed', 'conclusion': 'failure',
                }
                c.gh.package_manifest = lambda _: artifact
                c.gh.result = lambda _: {
                    'schema': 1, 'project': target.project, 'repository_id': target.repository_id,
                    'release_id': rid, 'run_id': '7', 'sha': SHA, 'operation': m['operation'],
                    'artifact_digest': '0' * 64 if scenario == 'bad_digest' else digest(artifact),
                    'previous_version': m['expected_previous_version'],
                    'version_id': version, 'deployment_id': deployment,
                    'deploy_status': 'unknown' if scenario == 'not_deployed' else 'deployed',
                    'health_status': 'unhealthy',
                }
                snapshots = []
                def snapshot():
                    snapshots.append(True)
                    return {
                        'version_id': 'wrong' if scenario == 'wrong_version' else version,
                        'deployment_id': 'wrong' if scenario == 'wrong_deployment' or (
                            scenario == 'drift_during_health' and len(snapshots) > 1
                        ) else deployment,
                    }
                c.cf.snapshot = snapshot
                c.cf.health = lambda _: scenario != 'unhealthy'

                if scenario in {'wrong_attempt', 'wrong_version', 'wrong_deployment', 'drift_during_health'}:
                    with self.assertRaises(ValueError):
                        _reconcile(c, rid, recover_confirmed=True)
                else:
                    _reconcile(c, rid, recover_confirmed=scenario != 'automatic_poll')
                row = c.store.get(rid)
                if scenario == 'verified':
                    self.assertEqual(row['state'], 'RECONCILED_HEALTHY')
                    self.assertEqual(row['evidence']['workflow_conclusion'], 'failure')
                    self.assertEqual(row['evidence']['health_status'], 'unhealthy')
                    self.assertEqual(row['evidence']['reconcile_health_status'], 'healthy')
                    self.assertEqual(len(snapshots), 2)
                    self.assertEqual(_reconcile(c, rid)['state'], 'RECONCILED_HEALTHY')
                    with self.assertRaises(ValueError):
                        c.store.healthy_version(version)
                    c.store.prepare({**m, 'release_id': 'rel_next'})
                    self.assertEqual(c.store.get('rel_next')['state'], 'PREPARED')
                else:
                    self.assertEqual(row['state'], 'DISPATCHED' if scenario == 'unclaimed' else 'DEPLOY_UNCERTAIN')
                    with self.assertRaisesRegex(ValueError, 'active release'):
                        c.store.prepare({**m, 'release_id': 'rel_next'})
