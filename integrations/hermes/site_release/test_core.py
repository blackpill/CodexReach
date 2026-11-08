import json,tempfile,unittest,time
from pathlib import Path
from dataclasses import replace
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
import jwt
from .config import get_target,ReleaseConfig,production_config
from .store import Store
from .approval import verify_confirmation
from .tickets import sign_ticket,verify_ticket
from .oidc import verify_github_oidc,ISSUER
A=get_target('usmapgames');B=get_target('colorearmundo');SHA='a'*40

def manifest(t=A,now=100):
 from .manifest import digest
 return {'schema':1,'project':t.project,'release_id':'rel_unit','repository':t.repository,'repository_id':t.repository_id,'worker':t.worker,'environment':'production','operation':'deploy','target_sha':SHA,'target_version':None,'expected_previous_version':'11111111-1111-1111-1111-111111111111','expected_previous_deployment':'dep','config_digest':digest(production_config(t)),'baseline_config_digest':'baseline','source_sha':None,'baseline_unmapped':True,'prepared_at':now,'expires_at':now+600,'nonce':'unit_nonce','thread_id':None}
def approval(t=A,now=100):
 m=manifest(t,now)
 return {k:m[k] for k in ['schema','project','repository','repository_id','worker','environment','release_id','operation','target_sha','target_version','expected_previous_version','config_digest']}|{'approved_by':'ou_owner','approved_at':now,'expires_at':now+5400}
def message(t=A):return {'message_id':'om_unit','chat_id':t.chat_id,'create_time':'101000','update_time':'101000','updated':False,'deleted':False,'msg_type':'text','sender':{'sender_type':'user','id_type':'open_id','id':'ou_owner','tenant_key':'tenant'},'body':{'content':json.dumps({'text':'确认发布 rel_unit unit_nonce'})}}
def keys():
 k=Ed25519PrivateKey.generate();return k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()),k.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo)
class CoreTests(unittest.TestCase):
 def test_store_scope_and_durable_dispatch(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'db';s=Store(p,A);s.prepare(manifest());s.approve_for_dispatch('rel_unit','om_unit','ou_owner',101);s.close();s=Store(p,A)
   self.assertEqual(s.get('rel_unit')['state'],'DISPATCH_UNCERTAIN');s.close()
   with self.assertRaises(ValueError):Store(p,B)
 def test_cross_scope_prepare_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   s=Store(Path(d)/'a',A)
   for field,value in [('project',B.project),('repository_id',B.repository_id),('repository',B.repository),('worker',B.worker)]:
    with self.subTest(field=field),self.assertRaises(ValueError):s.prepare({**manifest(),field:value})
   self.assertEqual(s.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0],0);s.close()
 def test_confirmation_cannot_cross_group_or_identity(self):
  c=ReleaseConfig(A,True,('ou_owner',),'tenant');self.assertEqual(verify_confirmation(message(),manifest(),c,102000)['actor_id'],'ou_owner')
  for patch in [{'chat_id':B.chat_id},{'updated':True},{'deleted':True},{'update_time':'102000'},{'sender':{**message()['sender'],'sender_type':'app'}},{'sender':{**message()['sender'],'tenant_key':'other'}},{'body':{'content':json.dumps({'text':'确认发布 rel_unit unit_nonce '})}}]:
   with self.subTest(patch=patch),self.assertRaises(ValueError):verify_confirmation({**message(),**patch},manifest(),c,102000)
  with self.assertRaises(ValueError):verify_confirmation(message(),manifest(),c,700000)
 def test_ticket_scope_keys_lifetime_and_fields(self):
  private,public=keys();token=sign_ticket(approval(),private);self.assertEqual(verify_ticket(token,public,101,A),approval())
  _,other=keys()
  for key,t,now in [(public,B,101),(other,A,101),(public,A,5500)]:
   with self.subTest(t=t.project,now=now),self.assertRaises(ValueError):verify_ticket(token,key,now,t)
  for changes in [{'schema':2},{'extra':1},{'expires_at':5501},{'repository_id':B.repository_id},{'worker':B.worker}]:
   with self.subTest(changes=changes),self.assertRaises(ValueError):sign_ticket({**approval(),**changes},private)
 def test_claim_once_and_cancel_guard(self):
  with tempfile.TemporaryDirectory() as d:
   s=Store(Path(d)/'db',A);s.prepare(manifest());s.approve_for_dispatch('rel_unit','om_unit','ou_owner',101);s.transition('rel_unit','DISPATCH_UNCERTAIN','DISPATCHED',{'run_id':'7'});s.claim('rel_unit','7',1,102)
   for action in [lambda:s.claim('rel_unit','7',1,103),lambda:s.cancel('rel_unit')]:
    with self.assertRaises(ValueError):action()
   s.close()
 def test_oidc_target_and_required_fixed_claims(self):
  k=rsa.generate_private_key(public_exponent=65537,key_size=2048);now=int(time.time())
  claims={'iss':ISSUER,'aud':A.audience,'iat':now,'nbf':now,'exp':now+300,'repository_id':str(A.repository_id),'workflow_ref':A.repository+'/.github/workflows/deploy-production.yml@refs/heads/main','workflow_sha':SHA,'sha':SHA,'ref':'refs/heads/main','event_name':'workflow_dispatch','run_id':'7','run_attempt':'1','runner_environment':'github-hosted'}
  expected={'workflow_sha':SHA,'sha':SHA,'run_id':'7'}
  def token(c):return jwt.encode(c,k,algorithm='RS256')
  self.assertEqual(verify_github_oidc(token(claims),expected,now,A,lambda _:k.public_key())['run_id'],'7')
  for patch in [{'aud':B.audience},{'repository_id':str(B.repository_id)},{'run_attempt':'2'},{'event_name':'pull_request'},{'runner_environment':'self-hosted'},{'sha':'b'*40}]:
   with self.subTest(patch=patch),self.assertRaises(ValueError):verify_github_oidc(token({**claims,**patch}),expected,now,A,lambda _:k.public_key())
