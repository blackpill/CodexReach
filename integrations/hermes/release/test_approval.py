import copy,json,unittest
from dataclasses import replace
from integrations.hermes.release.config import ReleaseConfig
from integrations.hermes.release.approval import verify_confirmation

class ApprovalTests(unittest.TestCase):
 def setUp(self):
  self.c=replace(ReleaseConfig(),allowed_users=('ou_owner',),tenant_key='tenant')
  self.m={'release_id':'r1','nonce':'secretcode','prepared_at':100,'expires_at':700,'thread_id':None}
  self.msg={'message_id':'om_1','chat_id':self.c.chat_id,'create_time':'101000','update_time':'101000','updated':False,'deleted':False,'msg_type':'text','sender':{'id':'ou_owner','id_type':'open_id','sender_type':'user','tenant_key':'tenant'},'body':{'content':json.dumps({'text':'确认发布 r1 secretcode'})}}
 def test_valid_human(self):self.assertEqual(verify_confirmation(self.msg,self.m,self.c,102000)['actor_id'],'ou_owner')
 def test_fail_closed(self):
  changes=[('sender',{'id':'ou_owner','sender_type':'app'}),('sender',{'id':'ou_other','sender_type':'user'}),('chat_id','other'),('updated',True),('deleted',True),('msg_type','post'),('create_time','999999999'),('update_time','102000'),('body',{'content':'{"text":"引用 确认发布 r1 secretcode"}'}),('body',{'content':'{"text":"确认发布 r1 bad"}'})]
  for key,val in changes:
   with self.subTest(key=key,val=val),self.assertRaises(ValueError):verify_confirmation({**self.msg,key:val},self.m,self.c,102000)
  for key in list(self.msg):
   m={**self.msg};del m[key]
   with self.subTest(missing=key),self.assertRaises(ValueError):verify_confirmation(m,self.m,self.c,102000)
 def test_empty_allowlist_and_expiry_and_thread(self):
  for c,m,now in [(ReleaseConfig(),self.m,102000),(self.c,self.m,700000),(self.c,{**self.m,'thread_id':'omt_x'},102000)]:
   with self.assertRaises(ValueError):verify_confirmation(self.msg,m,c,now)
