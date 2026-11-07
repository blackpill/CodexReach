import time,unittest,jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from integrations.hermes.release.tickets import sign_ticket,verify_ticket
from integrations.hermes.release.oidc import verify_github_oidc
class TicketTests(unittest.TestCase):
 def setUp(self):
  self.k=Ed25519PrivateKey.generate();self.pem=self.k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption());self.pub=self.k.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo)
  self.now=int(time.time());self.a={'release_id':'r1','operation':'deploy','repository_id':1223017142,'target_sha':'a'*40,'target_version':None,'environment':'production','expected_previous_version':'v1','config_digest':'b'*64,'approved_by':'ou_owner','approved_at':self.now,'expires_at':self.now+5400}
 def test_signature_and_expiration(self):
  ticket=sign_ticket(self.a,self.pem);self.assertEqual(verify_ticket(ticket,self.pub,self.now),self.a)
  for token,now in [(ticket+'x',self.now),(ticket,self.now+5400)]:
   with self.assertRaises(ValueError):verify_ticket(token,self.pub,now)
  with self.assertRaises(ValueError):sign_ticket({**self.a,'operation':'rollback'},self.pem)
 def test_oidc_real_signatures_and_claims(self):
  claims={'iss':'https://token.actions.githubusercontent.com','aud':'classgames-release-control','iat':self.now,'nbf':self.now-1,'exp':self.now+300,'repository_id':'1223017142','workflow_ref':'blackpill/classgames.net/.github/workflows/deploy-production.yml@refs/heads/main','workflow_sha':'a'*40,'sha':'a'*40,'ref':'refs/heads/main','event_name':'workflow_dispatch','run_id':'10','run_attempt':'1','runner_environment':'github-hosted'}
  # Tests use a real RSA key, the same algorithm as GitHub OIDC.
  from cryptography.hazmat.primitives.asymmetric.rsa import generate_private_key
  key=generate_private_key(public_exponent=65537,key_size=2048)
  resolver=lambda t:key.public_key()
  expected={'workflow_sha':'a'*40,'run_id':'10'}
  token=jwt.encode(claims,key,algorithm='RS256');self.assertEqual(verify_github_oidc(token,expected,self.now,resolver)['run_id'],'10')
  for field,val in [('repository_id','1'),('aud','other'),('event_name','push'),('run_attempt','2'),('workflow_sha','b'*40),('exp',self.now-1)]:
   with self.subTest(field=field),self.assertRaises(ValueError):verify_github_oidc(jwt.encode({**claims,field:val},key,algorithm='RS256'),expected,self.now,resolver)
