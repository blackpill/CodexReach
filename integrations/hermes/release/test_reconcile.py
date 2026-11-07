import tempfile,unittest,time
from pathlib import Path
from integrations.hermes.release.store import Store
from integrations.hermes.release.controller import Controller
from integrations.hermes.release.config import ReleaseConfig
from integrations.hermes.release.manifest import prepare_manifest
from integrations.hermes.release.reconcile import reconcile
from integrations.hermes.release.test_manifest import Gh,Cf
from integrations.hermes.release.test_controller import Fs
class ReconcileTests(unittest.TestCase):
 def test_verified_result_updates_state_but_never_dispatches(self):
  with tempfile.TemporaryDirectory() as td:
   now=int(time.time());s=Store(Path(td)/'db');m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),now);rid=m['release_id'];s.prepare(m);s.approve(rid,'om_1','ou_owner',now);s.transition(rid,'APPROVED','DISPATCHED',{'run_id':'5'});s.claim(rid,'5',1,now)
   g=Gh();g.run=lambda r:{'id':5,'head_sha':'a'*40,'event':'workflow_dispatch','path':'.github/workflows/deploy-production.yml','run_attempt':1,'status':'completed'}
   g.result=lambda r:{'release_id':rid,'run_id':'5','operation':'deploy','sha':'a'*40,'previous_version':'version1','version_id':'vnew','deployment_id':'dnew','deploy_status':'deployed','health_status':'healthy'}
   cf=Cf();cf.snapshot=lambda:{'version_id':'vnew','deployment_id':'dnew'};cf.health=lambda sha:True
   c=Controller(ReleaseConfig(),s,g,cf,Fs(),b'');self.assertEqual(reconcile(c,rid)['state'],'HEALTHY');self.assertEqual(reconcile(c,rid)['state'],'HEALTHY');s.close()
 def test_missing_result_after_claim_is_unknown_not_validation_failure(self):
  with tempfile.TemporaryDirectory() as td:
   now=int(time.time());s=Store(Path(td)/'db');m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),now);rid=m['release_id'];s.prepare(m);s.approve(rid,'om_1','ou_owner',now);s.transition(rid,'APPROVED','DISPATCHED',{'run_id':'5'});s.claim(rid,'5',1,now)
   g=Gh();g.run=lambda r:{'id':5,'head_sha':'a'*40,'event':'workflow_dispatch','path':'.github/workflows/deploy-production.yml','run_attempt':1,'status':'completed'}
   def missing(r):raise ValueError()
   g.result=missing;c=Controller(ReleaseConfig(),s,g,Cf(),Fs(),b'');self.assertEqual(reconcile(c,rid)['state'],'DEPLOY_UNCERTAIN');s.close()
