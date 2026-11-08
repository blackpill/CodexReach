import tempfile,unittest
from pathlib import Path
from .test_core import A,B,keys,manifest
from .test_clients import Gh,CfFixture
from .test_controller import Fs
from .config import ReleaseConfig
from .store import Store
from .manifest import prepare_manifest
from .controller import Controller
from .cloudflare import CloudflareReadClient
from .server import ClaimService,approval_claims
from .tickets import sign_ticket
from .reconcile import reconcile
class RegressionTests(unittest.TestCase):
 def setup_controller(self,path,t=A):
  cfg=ReleaseConfig(t,True,('ou_owner',),'tenant');store=Store(path,t);gh=Gh(t);f=CfFixture(t)
  if t==B:f.binding.append({'name':'COLORING_ASSETS','type':'r2_bucket','bucket_name':'colorearmundo-assets'})
  cf=CloudflareReadClient(cfg,'fake',f.request);private,public=keys();return Controller(cfg,store,gh,cf,Fs(t),private),public
 def test_uncertain_notice_does_not_create_another_release(self):
  with tempfile.TemporaryDirectory() as d:
   c,_=self.setup_controller(Path(d)/'db');c.feishu.send_text=lambda *a: (_ for _ in ()).throw(TimeoutError());r=c.prepare(100)
   self.assertTrue(r['evidence']['notice_error'])
   with self.assertRaises(ValueError):c.prepare(101)
   self.assertEqual(c.store.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0],1)
   self.assertEqual(c.store.cancel(r['id'])['state'],'CANCELLED');c.store.close()
 def test_unknown_version_does_not_automatically_rollback(self):
  with tempfile.TemporaryDirectory() as d:
   c,_=self.setup_controller(Path(d)/'db')
   with self.assertRaises(ValueError):c.prepare_rollback('11111111-1111-1111-1111-111111111111',100)
   c.store.close()
 def test_claim_exact_site_once_and_wrong_result_never_healthy(self):
  for t in [A,B]:
   with tempfile.TemporaryDirectory() as d:
    c,public=self.setup_controller(Path(d)/'db',t);m=prepare_manifest(c.config,c.gh,c.cf,100);c.store.prepare(m);c.store.approve_for_dispatch(m['release_id'],'om_unit','ou_owner',101);r=c.store.transition(m['release_id'],'DISPATCH_UNCERTAIN','DISPATCHED',{'run_id':'7'});ticket=sign_ticket(approval_claims(r),c.private_key)
    def oidc(token,expected,now,target):
     self.assertEqual(target,t);self.assertEqual(expected['run_id'],'7');return {'run_id':'7','run_attempt':'1'}
    svc=ClaimService(c.config,c.store,c.gh,c.cf,public,oidc);self.assertTrue(svc.claim(r['id'],ticket,'fake',102)['granted'])
    with self.assertRaises(ValueError):svc.claim(r['id'],ticket,'fake',103)
    c.gh.run=lambda _:{'id':7,'head_sha':m['target_sha'],'event':'workflow_dispatch','path':'.github/workflows/deploy-production.yml','run_attempt':1,'status':'completed'}
    c.gh.result=lambda _:{'schema':1,'project':B.project if t==A else A.project,'repository_id':t.repository_id,'release_id':r['id'],'run_id':'7','sha':m['target_sha'],'operation':'deploy','previous_version':m['expected_previous_version']}
    self.assertEqual(reconcile(c,r['id'],104)['state'],'DEPLOY_UNCERTAIN');c.store.close()
 def test_cli_fixed_project(self):
  from .cli import parser
  import contextlib,io
  with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):parser(A).parse_args(['prepare','--project','colorearmundo'])
