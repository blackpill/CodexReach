import unittest,tempfile,json,time,threading,socket,urllib.request
from pathlib import Path
from integrations.hermes.release.store import Store
from integrations.hermes.release.config import ReleaseConfig
from integrations.hermes.release.test_manifest import Gh,Cf
from integrations.hermes.release.manifest import prepare_manifest
from integrations.hermes.release.controller import Controller
from integrations.hermes.release.test_controller import Fs
from integrations.hermes.release.cloudflare import CloudflareReadClient
class ReviewRegressions(unittest.TestCase):
 def test_atomic_approval_already_reserves_dispatch_after_reopen(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td)/'db';s=Store(p);m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),100);s.prepare(m);s.approve_for_dispatch(m['release_id'],'om_1','ou_owner',101);s.close();s=Store(p)
   self.assertEqual(s.get(m['release_id'])['state'],'DISPATCH_UNCERTAIN');s.close()
 def test_domains_removed_disabled_or_moved_are_rejected(self):
  c=ReleaseConfig();domains=[{'hostname':h,'enabled':True,'service':'classgames','environment':'production','zone_id':'3a05bbc484d36da05b864c2a509c6a0b'} for h in ['classgames.net','www.classgames.net']]
  settings={'compatibility_date':'2026-07-31','bindings':[{'name':'ASSETS','type':'assets'}]}
  def transport(method,url,*args):
   if 'domains/records' in url:r=transport.domains
   elif url.endswith('deployments'):r={'deployments':[{'id':'dep','versions':[{'version_id':'v','percentage':100}]}]}
   elif '/versions/' in url:r={'id':'v','resources':{'script_runtime':{'assets':{'not_found_handling':'404-page','raw_run_worker_first':True}}}}
   else:r=settings
   return {'success':True,'result':r}
  transport.domains=domains;cf=CloudflareReadClient(c,'fake',transport);cf.snapshot()
  for changed in [domains[:1],[{**domains[0],'enabled':False},domains[1]],[{**domains[0],'service':'other'},domains[1]]]:
   transport.domains=changed
   with self.subTest(changed=changed),self.assertRaises(ValueError):cf.snapshot()
 def test_known_version_gets_complete_change_list_before_notice(self):
  with tempfile.TemporaryDirectory() as td:
   s=Store(Path(td)/'db');m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),100);s.prepare(m);s.approve(m['release_id'],'om_1','ou_owner',101);s.transition(m['release_id'],'APPROVED','DISPATCHED',{'run_id':'5'});s.claim(m['release_id'],'5',1,102);s.transition(m['release_id'],'DEPLOYING','DEPLOYED',{'version_id':'version1'});s.transition(m['release_id'],'DEPLOYED','HEALTHY',{})
   g=Gh();g.main_head=lambda:'b'*40;g.changes=lambda a,b:[{'sha':'b'*40,'title':'Feature','prs':[7]}]
   f=Fs();f.send_text=lambda chat,text,rid: (self.assertIn('#7',text) or 'om_notice')
   row=Controller(ReleaseConfig(),s,g,Cf(),f,b'').prepare(200)
   self.assertEqual(row['manifest']['source_sha'],'a'*40);self.assertFalse(row['manifest']['baseline_unmapped']);self.assertEqual(row['manifest']['changes'][0]['prs'],[7]);s.close()
 def test_failure_notice_can_retry_without_any_dispatch(self):
  from integrations.hermes.release.notices import publish_status
  with tempfile.TemporaryDirectory() as td:
   s=Store(Path(td)/'db');m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),100);s.prepare(m);s.approve(m['release_id'],'om_1','ou_owner',101);s.transition(m['release_id'],'APPROVED','DISPATCHED',{'run_id':'5'});s.transition(m['release_id'],'DISPATCHED','VALIDATION_FAILED',{})
   f=Fs();calls=[]
   def send(chat,text,uuid):
    calls.append(uuid)
    if len(calls)==1:raise TimeoutError()
    return 'om_notice'
   f.send_text=send;c=Controller(ReleaseConfig(),s,Gh(),Cf(),f,b'')
   publish_status(c,m['release_id'],200);publish_status(c,m['release_id'],231)
   self.assertEqual(len(calls),2);self.assertEqual(calls[0],calls[1]);self.assertEqual(s.get(m['release_id'])['state'],'VALIDATION_FAILED');s.close()
 def test_incomplete_http_request_does_not_block_another_claim(self):
  from integrations.hermes.release.server import ClaimHTTPServer,make_handler
  class Svc:
   def claim(self,*args):return {'granted':True}
  srv=ClaimHTTPServer(('127.0.0.1',0),make_handler(Svc(),read_timeout=3));t=threading.Thread(target=srv.serve_forever,daemon=True);t.start();slow=socket.create_connection(srv.server_address)
  try:
   slow.sendall(b'POST /v1/claims HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: Bearer fake\r\nContent-Length: 100\r\n\r\n')
   req=urllib.request.Request('http://127.0.0.1:%d/v1/claims'%srv.server_port,data=b'{"release_id":"r1","ticket":"t"}',headers={'Content-Type':'application/json','Authorization':'Bearer fake'})
   start=time.monotonic()
   with urllib.request.urlopen(req,timeout=1) as r:self.assertEqual(r.status,200)
   self.assertLess(time.monotonic()-start,1)
  finally:slow.close();srv.shutdown();srv.server_close();t.join()
