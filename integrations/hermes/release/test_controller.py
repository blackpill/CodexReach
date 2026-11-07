import tempfile,json,time,unittest
from pathlib import Path
from dataclasses import replace
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from integrations.hermes.release.config import ReleaseConfig
from integrations.hermes.release.store import Store
from integrations.hermes.release.test_manifest import Gh,Cf
from integrations.hermes.release.controller import Controller
class Fs:
 def send_text(self,c,t,r):return 'om_notice'
 def get_message(self,mid):return self.message
 def find_confirmation(self,*a):return ['om_1']
class G(Gh):
 calls=0
 def dispatch(self,*args):self.calls+=1;raise TimeoutError()
class ControllerTests(unittest.TestCase):
 def test_authoritative_confirmation_and_unknown_dispatch_never_retry(self):
  with tempfile.TemporaryDirectory() as td:
   s=Store(Path(td)/'db');now=int(time.time());cfg=replace(ReleaseConfig(),production_enabled=True,allowed_users=('ou_owner',),tenant_key='t');f=Fs();g=G();k=Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption());c=Controller(cfg,s,g,Cf(),f,k)
   m=c.prepare(now)['manifest'];f.message={'message_id':'om_1','chat_id':cfg.chat_id,'create_time':str(now*1000),'update_time':str(now*1000),'updated':False,'deleted':False,'msg_type':'text','sender':{'id':'ou_owner','id_type':'open_id','sender_type':'user','tenant_key':'t'},'body':{'content':json.dumps({'text':f"确认发布 {m['release_id']} {m['nonce']}"})}}
   self.assertEqual(c.confirm(m['release_id'],'om_1',now)['state'],'DISPATCH_UNCERTAIN')
   with self.assertRaises(ValueError):c.confirm(m['release_id'],'om_1',now)
   self.assertEqual(g.calls,1);s.close()
 def test_disabled_and_ambiguous_never_approve(self):
  with tempfile.TemporaryDirectory() as td:
   s=Store(Path(td)/'db');f=Fs();c=Controller(ReleaseConfig(),s,G(),Cf(),f,b'');m=c.prepare(100)['manifest']
   with self.assertRaises(ValueError):c.confirm(m['release_id'],'om_1',101)
   f.find_confirmation=lambda *a:['om_1','om_2']
   with self.assertRaises(ValueError):c.locate(m['release_id'])
   s.close()
