import tempfile,unittest,json
from pathlib import Path
from .test_core import A,B,manifest,message,keys,SHA
from .test_clients import Gh,CfFixture
from .config import ReleaseConfig
from .store import Store
from .cloudflare import CloudflareReadClient
from .controller import Controller
from .server import ClaimService
class Fs:
 def __init__(self,t=A):self.t=t;self.sent=[]
 def send_text(self,chat,text,rid):self.sent.append(text);return 'om_notice'
 def get_message(self,mid):return message(self.t)
 def find_confirmation(self,*a):return ['om_unit']
class ControllerTests(unittest.TestCase):
 def test_prepare_unknown_mapping_and_dispatch_only_after_verified_human(self):
  for t in [A,B]:
   with tempfile.TemporaryDirectory() as d:
    cfg=ReleaseConfig(t,True,('ou_owner',),'tenant');s=Store(Path(d)/'db',t);g=Gh(t);f=CfFixture(t)
    if t==B:f.binding.append({'name':'COLORING_ASSETS','type':'r2_bucket','bucket_name':'colorearmundo-assets'})
    cf=CloudflareReadClient(cfg,'fake',f.request);fs=Fs(t);private,_=keys();c=Controller(cfg,s,g,cf,fs,private)
    row=c.prepare(100);self.assertEqual(row['state'],'PREPARED');self.assertIn('线上 SHA 未知',fs.sent[0])
    m=row['manifest'];msg=message(t);msg['body']['content']=json.dumps({'text':f"确认发布 {row['id']} {m['nonce']}"});fs.get_message=lambda _:msg
    calls=[];g.dispatch=lambda *a:calls.append(a) or {};r=c.confirm(row['id'],'om_unit',101)
    self.assertEqual(r['state'],'DISPATCH_UNCERTAIN');self.assertEqual(len(calls),1)
    with self.assertRaises(ValueError):c.confirm(row['id'],'om_unit',102)
    self.assertEqual(len(calls),1);s.close()
 def test_disabled_does_not_dispatch(self):
  with tempfile.TemporaryDirectory() as d:
   s=Store(Path(d)/'db',A);s.prepare(manifest());c=Controller(ReleaseConfig(A),s,None,None,None,b'')
   with self.assertRaises(ValueError):c.confirm('rel_unit','om_unit',101)
   s.close()
 def test_http_surface_and_slow_request(self):
  import threading,socket,urllib.request,urllib.error
  from .server import ClaimHTTPServer,make_handler
  class Deny:
   def claim(self,*args):raise ValueError('No authorization')
  srv=ClaimHTTPServer(('127.0.0.1',0),make_handler(Deny(),read_timeout=1));thread=threading.Thread(target=srv.serve_forever,daemon=True);thread.start();slow=socket.create_connection(srv.server_address)
  try:
   slow.sendall(b'POST /v1/claims HTTP/1.1\r\nContent-Length: 100\r\n')
   req=urllib.request.Request('http://127.0.0.1:%d/v1/claims'%srv.server_port,data=b'{}',headers={'Content-Type':'application/json','Authorization':'Bearer fake'})
   with self.assertRaises(urllib.error.HTTPError) as cm:urllib.request.urlopen(req,timeout=1)
   self.assertEqual(cm.exception.code,403);cm.exception.close()
  finally:slow.close();srv.shutdown();srv.server_close();thread.join()
