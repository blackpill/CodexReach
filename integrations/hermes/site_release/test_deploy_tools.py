import json,tempfile,unittest,hashlib
from pathlib import Path
from .test_core import A,B,SHA,approval,keys
from .config import production_config
from .manifest import digest
from .tickets import sign_ticket
from .deploy_tools.runner import verify_package,run_release

def package(root,t=A):
 (root/'assets').mkdir();(root/'bundle.mjs').write_text('export default {fetch(){return new Response("ok")}};');(root/'wrangler.json').write_text(json.dumps(production_config(t)));(root/'assets/__release.json').write_text(json.dumps({'schema':1,'project':t.project,'sha':SHA}))
 files={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
 m={'schema':1,'project':t.project,'repository':t.repository,'repository_id':t.repository_id,'sha':SHA,'config_digest':digest(production_config(t)),'files':files};(root/'manifest.json').write_text(json.dumps(m));return m
class DeployTests(unittest.TestCase):
 def test_package_identity_exact_files_and_cross_site(self):
  for t in [A,B]:
   with tempfile.TemporaryDirectory() as d:
    p=Path(d);m=package(p,t);self.assertEqual(verify_package(p,SHA,t),m)
    with self.assertRaises(ValueError):verify_package(p,SHA,B if t==A else A)
    (p/'evil').write_text('x')
    with self.assertRaises(ValueError):verify_package(p,SHA,t)
 def test_symlink_and_config_changes(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);package(p);(p/'assets/link').symlink_to('/etc/passwd')
   with self.assertRaises(ValueError):verify_package(p,SHA,A)
 def test_receipt_claim_and_deploy_no_retry(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);package(p);private,public=keys();ticket=sign_ticket(approval(),private);calls=[]
   def deny(_):calls.append('claim');return {'granted':False}
   def deploy():calls.append('deploy');raise TimeoutError()
   with self.assertRaises(ValueError):run_release(p,SHA,'rel_unit','7',ticket,public,deny,deploy,None,None,101,A)
   self.assertEqual(calls,['claim']);calls.clear()
   r=run_release(p,SHA,'rel_unit','7',ticket,public,lambda _:{'granted':True},deploy,None,None,101,A)
   self.assertEqual(calls,['deploy']);self.assertEqual(r['deploy_status'],'unknown');self.assertEqual(r['project'],A.project)
 def test_cross_site_ticket_rejected_before_claim(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);package(p,B);private,public=keys();ticket=sign_ticket(approval(),private)
   with self.assertRaises(ValueError):run_release(p,SHA,'rel_unit','7',ticket,public,lambda _:self.fail('No claim'),None,None,None,101,B)
