import tempfile,time,unittest
from pathlib import Path
from dataclasses import replace
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from integrations.hermes.release.config import ReleaseConfig
from integrations.hermes.release.store import Store
from integrations.hermes.release.manifest import prepare_manifest
from integrations.hermes.release.test_manifest import Gh,Cf
from integrations.hermes.release.server import ClaimService,approval_claims
from integrations.hermes.release.tickets import sign_ticket
class ClaimTests(unittest.TestCase):
 def test_binding_disabled_and_single_claim(self):
  with tempfile.TemporaryDirectory() as td:
   s=Store(Path(td)/'db');now=int(time.time());m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),now);s.prepare(m);s.approve(m['release_id'],'om_1','ou_owner',now);s.transition(m['release_id'],'APPROVED','DISPATCHED',{'run_id':'5'})
   k=Ed25519PrivateKey.generate();pem=k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption());pub=k.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo)
   ticket=sign_ticket(approval_claims(s.get(m['release_id'])),pem)
   service=ClaimService(ReleaseConfig(),s,Gh(),Cf(),pub,lambda t,e,n:{'run_id':'5','run_attempt':'1'})
   with self.assertRaises(ValueError):service.claim(m['release_id'],ticket,'fake',now)
   service.config=replace(ReleaseConfig(),production_enabled=True)
   self.assertTrue(service.claim(m['release_id'],ticket,'fake',now)['granted'])
   with self.assertRaises(ValueError):service.claim(m['release_id'],ticket,'fake',now)
   s.close()
