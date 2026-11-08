"""Uninstalled daemon entrypoint; service-only credentials never reach Hermes CLI."""
import json,os,socketserver,threading,time
from pathlib import Path
from http.server import HTTPServer
from .config import get_target
from .config import load_config
from .store import Store
from .github import GithubClient
from .app_auth import installation_token
from .cloudflare import CloudflareReadClient
from .feishu import FeishuClient
from .controller import Controller
from .server import ClaimService,make_handler,ClaimHTTPServer
from .reconcile import reconcile


def controller(target):
 HOME=target.home
 c=load_config(target.project,HOME/'config.json')
 token=installation_token(target,os.environ['RELEASE_GITHUB_APP_ID'],os.environ['RELEASE_GITHUB_INSTALLATION_ID'],(HOME/'github-app.pem').read_bytes(),int(time.time()))
 key=(HOME/'private-key.pem').read_bytes()
 gh=GithubClient(target,token);cf=CloudflareReadClient(c,os.environ['CLOUDFLARE_READ_TOKEN']);feishu=FeishuClient(os.environ['FEISHU_APP_ID'],os.environ['FEISHU_APP_SECRET'])
 s=Store(HOME/'state/releases.sqlite',target)
 return Controller(c,s,gh,cf,feishu,key)

def dispatch(c,d):
 allowed={'prepare':{'command','project'},'prepare-rollback':{'command','project','version_id'},'confirm':{'command','release_id','message_id'}}
 cmd=d.get('command');expected=allowed.get(cmd,{'command','release_id'})
 if set(d)!=expected or ('project' in d and d['project']!=c.config.project):raise ValueError('Invalid request')
 now=int(time.time());rid=d.get('release_id')
 if cmd=='prepare':return c.prepare(now)
 if cmd=='prepare-rollback':return c.prepare_rollback(d['version_id'],now)
 if cmd=='confirm':return c.confirm(rid,d['message_id'],now)
 if cmd=='locate-confirmation':return c.locate(rid)
 if cmd=='status':return c.store.get(rid)
 if cmd=='cancel':return c.store.cancel(rid)
 if cmd=='reconcile':return reconcile(c,rid)
 raise ValueError('Invalid command')

def main():
 target=get_target(os.environ["SITE_RELEASE_PROJECT"]);HOME=target.home;SOCKET=target.socket
 class Local(socketserver.StreamRequestHandler):
  def handle(self):
   self.connection.settimeout(10);c=None
   try:
    raw=self.rfile.readline(16385)
    if len(raw)>16384 or not raw.endswith(b'\n'):raise ValueError()
    c=controller(target);result={'ok':True,'result':dispatch(c,json.loads(raw))}
   except Exception:result={'ok':False,'error':'Request rejected; inspect redacted status'}
   finally:
    if c:c.store.close()
   self.wfile.write(json.dumps(result,ensure_ascii=False).encode()+b'\n')
 class Public(make_handler(None)):
  def do_POST(self):
   auth=self.headers.get('Authorization','')
   if self.path!='/v1/claims' or not auth.startswith('Bearer '):self.send_error(403);return
   from .oidc import verify_github_oidc
   try:verify_github_oidc(auth[7:],{},int(time.time()),target)
   except Exception:self.send_error(403);return
   c=controller(target)
   try:
    handler=make_handler(ClaimService(c.config,c.store,c.gh,c.cf,(HOME/'public-key.pem').read_bytes()))
    handler.do_POST(self)
   finally:c.store.close()
 if Path(SOCKET).exists():raise ValueError('Socket already exists; do not replace a live service')
 unix=socketserver.UnixStreamServer(SOCKET,Local);os.chmod(SOCKET,0o600)
 http=ClaimHTTPServer(('127.0.0.1',target.port),Public)
 def poll():
  while True:
   c=None
   try:
    c=controller(target)
    ids=[r['id'] for r in c.store.db.execute("SELECT id FROM releases WHERE state IN ('DISPATCH_UNCERTAIN','DISPATCHED','DEPLOYING','DEPLOY_UNCERTAIN','DEPLOYED') OR id IN (SELECT release_id FROM notices WHERE status IN ('PENDING','IN_FLIGHT'))")]
    for rid in ids:
     try:reconcile(c,rid)
     except Exception:pass
   except Exception:pass
   finally:
    if c:c.store.close()
   time.sleep(30)
 threading.Thread(target=poll,daemon=True).start()
 threading.Thread(target=unix.serve_forever,daemon=True).start()
 http.serve_forever()
if __name__=='__main__':main()
