import unittest,tempfile
from pathlib import Path
from .test_core import A,B,SHA
from .test_clients import CfFixture
from . import test_review_regressions as regression_tests
from .github import GithubClient
from .manifest import prepare_manifest
from .reconcile import _reconcile
class FinalReviewTests(unittest.TestCase):
 def test_only_main_push_for_both_workflows(self):
  def api(method,url,*a):
   return {'workflow_runs':[{'head_sha':SHA,'event':'push','head_branch':'feature/not-main','status':'completed','conclusion':'success','path':'.github/workflows/'+(A.ci_workflow if A.ci_workflow in url else 'release-contracts.yml')}]}
  self.assertFalse(GithubClient(A,'fake',api).verified_workflow(SHA))
 def test_result_binding_negative_and_valid_rollback(self):
  from .manifest import digest
  for variant in ('wrong_version','missing_digest','valid'):
   with self.subTest(variant=variant),tempfile.TemporaryDirectory() as d:
    c,_=regression_tests.RegressionTests().setup_controller(Path(d)/'db');m=prepare_manifest(c.config,c.gh,c.cf,100);target='22222222-2222-2222-2222-222222222222';m.update(operation='rollback',workflow_sha=SHA,target_version=target);c.store.prepare(m);c.store.approve_for_dispatch(m['release_id'],'om_unit','ou_owner',101);c.store.transition(m['release_id'],'DISPATCH_UNCERTAIN','DISPATCHED',{'run_id':'7'});c.store.claim(m['release_id'],'7',1,102)
    version='33333333-3333-3333-3333-333333333333' if variant=='wrong_version' else target
    c.gh.run=lambda _:{'id':7,'head_sha':SHA,'event':'workflow_dispatch','path':'.github/workflows/deploy-production.yml','run_attempt':1,'status':'completed','conclusion':'success'}
    action={'schema':1,'operation':'rollback','project':A.project,'repository':A.repository,'repository_id':A.repository_id,'sha':SHA,'target_version':target,'config_digest':m['config_digest']}
    result={'schema':1,'project':A.project,'repository_id':A.repository_id,'release_id':m['release_id'],'run_id':'7','sha':SHA,'operation':'rollback','previous_version':m['expected_previous_version'],'deploy_status':'deployed','health_status':'healthy','version_id':version,'deployment_id':'dep','artifact_digest':digest(action)}
    if variant=='missing_digest':del result['artifact_digest']
    c.gh.result=lambda _:result;c.cf.snapshot=lambda:{'version_id':version,'deployment_id':'dep'};c.cf.health=lambda _:True
    state=_reconcile(c,m['release_id'])['state'];self.assertEqual(state,'HEALTHY' if variant=='valid' else 'DEPLOY_UNCERTAIN');c.store.close()
 def test_manifest_metadata_rejects_cross_scope_and_malformed_files(self):
  from .manifest import verify_artifact_manifest
  from .test_deploy_tools import package
  with tempfile.TemporaryDirectory() as d:
   m=package(Path(d));self.assertEqual(verify_artifact_manifest(m,A,SHA),m)
   for patch in [{'schema':True},{'project':B.project},{'config_digest':'0'*64},{'files':{'../evil':'0'*64}},{'extra':1}]:
    with self.subTest(patch=patch),self.assertRaises(ValueError):verify_artifact_manifest({**m,**patch},A,SHA)
