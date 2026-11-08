"""Claim-only external surface. No route can approve, dispatch or run a command."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import threading
import json,time
from .tickets import verify_ticket
from .oidc import verify_github_oidc
from .manifest import check_baseline

def approval_claims(row):
 m=row['manifest']
 return {k:m[k] for k in ['schema','project','repository','worker','release_id','operation','repository_id','target_sha','target_version','environment','expected_previous_version','config_digest']}|{'approved_by':row['actor'],'approved_at':row['approved_at'],'expires_at':row['approved_at']+5400}

class ClaimService:
 def __init__(self,config,store,gh,cf,public_key,oidc_verify=verify_github_oidc):self.config=config;self.store=store;self.gh=gh;self.cf=cf;self.public_key=public_key;self.oidc_verify=oidc_verify
 def claim(self,release_id,ticket,oidc_token,now):
  if not self.config.production_enabled:raise ValueError('Production disabled')
  row=self.store.get(release_id)
  if row['approved_at'] is None or row['state']!='DISPATCHED':raise ValueError('Not dispatched')
  claims=verify_ticket(ticket,self.public_key,now,self.config.target)
  if claims!=approval_claims(row):raise ValueError('Receipt does not match approval')
  identity=self.oidc_verify(oidc_token,{'workflow_sha':row['manifest'].get('workflow_sha',row['manifest']['target_sha']),'sha':row['manifest'].get('workflow_sha',row['manifest']['target_sha']),'run_id':row['run_id']},now,self.config.target)
  check_baseline(row['manifest'],self.gh,self.cf)
  self.store.claim(release_id,identity['run_id'],int(identity['run_attempt']),now)
  return {'granted':True,'release_id':release_id,'run_id':identity['run_id'],'operation':claims['operation']}

class ClaimHTTPServer(ThreadingHTTPServer):
 daemon_threads=True
 def __init__(self,*args,**kwargs):
  self.slots=threading.BoundedSemaphore(4);super().__init__(*args,**kwargs)
 def process_request(self,request,client_address):
  if not self.slots.acquire(blocking=False):request.close();return
  try:super().process_request(request,client_address)
  except BaseException:self.slots.release();raise
 def process_request_thread(self,*args):
  try:super().process_request_thread(*args)
  finally:self.slots.release()

def make_handler(service,read_timeout=5):
 class Handler(BaseHTTPRequestHandler):
  def setup(self):
   super().setup();self.connection.settimeout(read_timeout)
  def log_message(self,*args):pass
  def do_POST(self):
   try:
    if self.path!='/v1/claims':raise ValueError()
    n=int(self.headers.get('Content-Length','0'))
    if not 0<n<=24000 or self.headers.get('Content-Type')!='application/json':raise ValueError()
    auth=self.headers.get('Authorization','')
    if not auth.startswith('Bearer '):raise ValueError()
    d=json.loads(self.rfile.read(n))
    if set(d)!={'release_id','ticket'}:raise ValueError()
    result=service.claim(d['release_id'],d['ticket'],auth[7:],int(time.time()));code=200
   except Exception:result={'granted':False};code=403
   raw=json.dumps(result).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers()
   try:self.wfile.write(raw)
   except (OSError,TimeoutError):pass
 return Handler
