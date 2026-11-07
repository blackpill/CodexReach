import json,tempfile,unittest
from pathlib import Path
from integrations.hermes.release.deploy_tools.runner import verify_package
from integrations.hermes.release.config import production_config
from integrations.hermes.release.manifest import digest
import hashlib
class PackageTests(unittest.TestCase):
 def test_integrity_and_config_not_arbitrary_execution(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td);(p/'assets').mkdir();(p/'assets/__release.json').write_text(json.dumps({'sha':'a'*40}));(p/'bundle.mjs').write_text('export default {}');(p/'wrangler.json').write_text(json.dumps(production_config()))
   files={str(f.relative_to(p)):hashlib.sha256(f.read_bytes()).hexdigest() for f in p.rglob('*') if f.is_file()};m={'schema':1,'sha':'a'*40,'config_digest':digest(production_config()),'files':files};(p/'manifest.json').write_text(json.dumps(m))
   self.assertEqual(verify_package(p,'a'*40)['sha'],'a'*40)
   (p/'extra').write_text('bad')
   with self.assertRaises(ValueError):verify_package(p,'a'*40)
   (p/'extra').unlink();(p/'assets/x').symlink_to('/etc/passwd')
   with self.assertRaises(ValueError):verify_package(p,'a'*40)
 def test_claim_failure_does_not_deploy_and_unknown_is_not_retried(self):
  import time
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
  from cryptography.hazmat.primitives import serialization
  from integrations.hermes.release.tickets import sign_ticket
  from integrations.hermes.release.deploy_tools.runner import run_release
  from integrations.hermes.release.test_tickets import TicketTests
  fixture=TicketTests();fixture.setUp();a={**fixture.a,'config_digest':digest(production_config())};ticket=sign_ticket(a,fixture.pem)
  with tempfile.TemporaryDirectory() as td:
   p=Path(td);(p/'assets').mkdir();(p/'assets/__release.json').write_text(json.dumps({'sha':'a'*40}));(p/'bundle.mjs').write_text('export default {}');(p/'wrangler.json').write_text(json.dumps(production_config()));files={str(f.relative_to(p)):hashlib.sha256(f.read_bytes()).hexdigest() for f in p.rglob('*') if f.is_file()};(p/'manifest.json').write_text(json.dumps({'schema':1,'sha':'a'*40,'config_digest':digest(production_config()),'files':files}))
   calls=[]
   def deploy():calls.append('deploy');raise TimeoutError()
   with self.assertRaises(ValueError):run_release(p,'a'*40,'r1','5',ticket,fixture.pub,lambda a:{'granted':False},deploy,lambda:{},lambda s:True,fixture.now)
   self.assertEqual(calls,[])
   result=run_release(p,'a'*40,'r1','5',ticket,fixture.pub,lambda a:{'granted':True},deploy,lambda:{},lambda s:True,fixture.now)
   self.assertEqual(calls,['deploy']);self.assertEqual(result['deploy_status'],'unknown')
