"""Scoped draft-Issue and durable Base projection bridge; never grants Auto approval."""
import argparse, datetime, hashlib, json, os, re, sqlite3, subprocess, sys, urllib.request, urllib.error
from pathlib import Path
class BridgeError(RuntimeError): pass
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
class Github:
 def api(self,route,payload=None):
  cmd=['gh','api',route]
  if payload is not None:cmd+=['--method','POST','--input','-']
  r=subprocess.run(cmd,input=json.dumps(payload) if payload is not None else None,capture_output=True,text=True,timeout=45)
  if r.returncode: raise BridgeError('GitHub API failed; inspect repository authorization (credentials withheld)')
  return json.loads(r.stdout)
 def repository(self,repo):return self.api('repos/'+repo)
 def create(self,repo,payload):return self.api('repos/'+repo+'/issues',payload)
 def issue(self,repo,n):return self.api(f'repos/{repo}/issues/{int(n)}')
class Bridge:
 def __init__(self,db,projects,github):
  self.projects=projects;self.gh=github;self.db_path=str(db)
  Path(db).parent.mkdir(parents=True,exist_ok=True)
  self.db=sqlite3.connect(db);self.db.row_factory=sqlite3.Row;self.db.execute('pragma journal_mode=wal')
  self.db.execute('''create table if not exists requests(project text not null, request_id text not null, spec_hash text not null, payload text not null, state text not null, issue_number integer, issue_url text, record_id text, snapshot text, synced_at text, created_at text not null, primary key(project,request_id))''');self.db.execute('create table if not exists base_intents(project text,request_id text,phase text,primary key(project,request_id))');self.db.commit();Path(db).chmod(0o600)
 def close(self):self.db.close()
 def project(self,p):
  if p not in self.projects:raise BridgeError('Unknown project; no operation performed')
  c=self.projects[p]
  if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',c['repository']):raise BridgeError('Invalid registered repository')
  return c
 def create(self,p,req):
  c=self.project(p)
  if not isinstance(req,dict) or (req.get('project_id',p)!=p):raise BridgeError('Project mismatch')
  for k in ['request_id','title','body','acceptance']:
   if not isinstance(req.get(k),str) or not req[k].strip():raise BridgeError('Required request field: '+k)
  rid=req['request_id']
  if not re.fullmatch('[A-Za-z0-9_-]{1,100}',rid):raise BridgeError('Invalid request_id')
  if len(req['title'])>220 or len(req['body'])>40000 or len(req['acceptance'])>10000:raise BridgeError('Request too large')
  spec=json.dumps({k:req[k] for k in ['request_id','title','body','acceptance']},ensure_ascii=False,sort_keys=True);fingerprint=hashlib.sha256(spec.encode()).hexdigest()
  row=self.db.execute('select * from requests where project=? and request_id=?',(p,rid)).fetchone()
  if row:
   if row['spec_hash']!=fingerprint:raise BridgeError('Existing request changed; create a new revision and seek approval')
   if row['state']!='created':raise BridgeError('Prior create result uncertain; reconcile manually, never blindly retry')
   return self.result(row)
  repo=self.gh.repository(c['repository'])
  if str(repo.get('id'))!=str(c['repository_id']) or repo.get('full_name')!=c['repository']:raise BridgeError('Registered GitHub repository identity mismatch')
  # Reserve before any remote side effect; two local writers cannot both POST.
  try:
   with self.db:self.db.execute('insert into requests(project,request_id,spec_hash,payload,state,created_at) values(?,?,?,?,?,?)',(p,rid,fingerprint,spec,'posting',now()))
  except sqlite3.IntegrityError:raise BridgeError('Request is already reserved; reconcile instead of creating again')
  body=f'<!-- hermes_request:{p}:{rid} -->\nproject_id: {p}\nrequest_id: {rid}\nspec_sha256: {fingerprint}\n\n'+req['body']+'\n\n## 验收标准\n'+req['acceptance']+'\n\n## 人工审核与安全边界\n此Issue是待审核草稿，未添加Auto。只有用户blackpill明确审核后添加Auto才允许既有Runner执行。不得自动合并、部署或关闭Issue；PR_READY不代表上线。\n'
  try:
   issue=self.gh.create(c['repository'],{'title':req['title'],'body':body})
   n=issue.get('number');url=issue.get('html_url')
   if not isinstance(n,int) or isinstance(n,bool) or n<1 or url!=f'https://github.com/{c["repository"]}/issues/{n}':raise BridgeError('Unexpected GitHub issue identity')
   if any((x.get('name') if isinstance(x,dict) else x)=='Auto' for x in issue.get('labels',[])):raise BridgeError('Unexpected Auto label; manual review required')
   with self.db:self.db.execute('update requests set state=?,issue_number=?,issue_url=?,snapshot=? where project=? and request_id=?',('created',n,url,json.dumps({'state':issue.get('state','open'),'labels':[]}),p,rid))
  except Exception as ex:
   with self.db:self.db.execute('update requests set state=? where project=? and request_id=?',('uncertain',p,rid))
   raise BridgeError('Issue creation result uncertain; do not retry POST; reconcile on GitHub') from ex
  return self.result(self.db.execute('select * from requests where project=? and request_id=?',(p,rid)).fetchone())
 def result(self,row):
  r={'project_id':row['project'],'request_id':row['request_id'],'issue_number':row['issue_number'],'issue_url':row['issue_url'],'approval':json.loads(row['snapshot'] or '{}').get('approval','pending_human_Auto'),'execution':'unknown','pr_url':None,'base_record_id':row['record_id']}
  path=Path(self.db_path).parent/'executions.sqlite'
  if path.exists() and row['issue_number']:
   db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True)
   try: e=db.execute('select payload,last_seen from executions where project=? and issue=?',(row['project'],row['issue_number'])).fetchone()
   finally:db.close()
   if e:
    x=json.loads(e[0]);age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(e[1])).total_seconds()
    r.update({'execution':x['stage'] if age<=300 else 'unknown_stale','last_known_stage':x['stage'],'snapshot_version':x['version'],'snapshot_last_seen':e[1],'thread_id':x.get('thread_id'),'head_sha':x.get('head_sha'),'execution_source':'mac-sqlite-readonly-snapshot','runner_health':'unknown','evidence_limit':'last persisted SQLite record; not live Runner or current GitHub CI verification'})
    if x.get('pr_number'):r['pr_url']=f'https://github.com/{self.project(row["project"])["repository"]}/pull/{x["pr_number"]}'
  return r
 def list(self,p):
  self.project(p);return [self.result(r) for r in self.db.execute('select * from requests where project=? order by created_at desc',(p,))]
 def refresh(self,p):
  c=self.project(p);out=[]
  identity=self.gh.repository(c['repository'])
  if str(identity.get('id'))!=str(c['repository_id']) or identity.get('full_name')!=c['repository']:raise BridgeError('Registered repository identity changed; refuse refresh')
  for row in self.db.execute('select * from requests where project=? and state=?',(p,'created')).fetchall():
   d=self.gh.issue(c['repository'],row['issue_number']);expected=f'https://github.com/{c["repository"]}/issues/{row["issue_number"]}'
   if d.get('number')!=row['issue_number'] or d.get('html_url')!=expected:raise BridgeError('Issue snapshot identity mismatch')
   labels=[x['name'] if isinstance(x,dict) else x for x in d.get('labels',[])]
   snap={'state':d['state'],'labels':labels,'approval':'Auto_label_present' if 'Auto' in labels else 'pending_human_Auto','execution':'unknown','observed_at':now()}
   with self.db:self.db.execute('update requests set snapshot=?,synced_at=null where project=? and request_id=?',(json.dumps(snap),p,row['request_id']))
   out.append({'request_id':row['request_id'],**snap})
  return out
class Base:
 def __init__(self,manifest,envpath):
  self.m=manifest;self.env={}
  for l in Path(envpath).read_text().splitlines():
   if '=' in l and not l.lstrip().startswith('#'):
    k,v=l.split('=',1);self.env[k.strip()]=v.strip().strip('"\'')
  self.token=None
 def api(self,route,payload=None):
  headers={'Content-Type':'application/json'}
  if self.token:headers['Authorization']='Bearer '+self.token
  req=urllib.request.Request('https://open.feishu.cn/open-apis/'+route,data=json.dumps(payload,ensure_ascii=False).encode() if payload is not None else None,headers=headers)
  try:
   with urllib.request.urlopen(req,timeout=30) as r:d=json.load(r)
  except urllib.error.HTTPError as e:
   try:d=json.loads(e.read())
   except Exception:raise BridgeError('Feishu HTTP error '+str(e.code))
  if d.get('code')!=0:raise BridgeError('Feishu API code '+str(d.get('code'))+'; verify application scope/ACL')
  return d
 def login(self):self.token=self.api('auth/v3/tenant_access_token/internal',{'app_id':self.env['FEISHU_APP_ID'],'app_secret':self.env['FEISHU_APP_SECRET']})['tenant_access_token']
 def read_project(self,p,table):
  if table not in ['projects','requests','metrics']:raise BridgeError('Unknown business table')
  base=self.m.get('base_token');t=self.m.get('tables',{}).get(table,{});tid=t.get('table_id')
  if not re.fullmatch('[A-Za-z0-9]+',base or '') or not re.fullmatch('tbl[A-Za-z0-9]+',tid or ''):raise BridgeError('Base table not provisioned')
  self.login();out=[];page=''
  while True:
   d=self.api(f'bitable/v1/apps/{base}/tables/{tid}/records?page_size=500'+('&page_token='+page if page else ''))['data']
   for r in d.get('items',[]):
    if r.get('fields',{}).get('项目标识')==p:out.append(r)
   if not d.get('has_more'):return out
   page=d.get('page_token')
   if not page:raise BridgeError('Incomplete Base pagination')
 def upsert(self,p,rid,fields,known_record=None,allow_create=True):
  self.post_started=False
  # manifest comes from trusted provisioning, never from model request fields.
  base=self.m.get('base_token') or self.m.get('app_token');table=self.m['tables']['requests'];tid=table['table_id'] if isinstance(table,dict) else table
  if not re.fullmatch('[A-Za-z0-9]+',base or '') or not re.fullmatch('tbl[A-Za-z0-9]+',tid):raise BridgeError('Base not provisioned')
  self.login();path=f'bitable/v1/apps/{base}/tables/{tid}/records';matches=[];page=''
  while True:
   d=self.api(path+'?page_size=500'+('&page_token='+page if page else ''))['data']
   for r in d.get('items',[]):
    f=r.get('fields',{})
    if f.get('需求ID')==rid and f.get('项目标识')==p:matches.append(r['record_id'])
   if not d.get('has_more'):break
   page=d.get('page_token');
   if not page:raise BridgeError('Incomplete Base pagination')
  if len(matches)>1:raise BridgeError('Ambiguous Base request records; manual reconciliation needed')
  if known_record and matches!=[known_record]:raise BridgeError('Base record identity changed; refuse overwrite')
  if matches:
   req=urllib.request.Request('https://open.feishu.cn/open-apis/'+path+'/'+matches[0],data=json.dumps({'fields':fields},ensure_ascii=False).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+self.token},method='PUT')
   try:
    with urllib.request.urlopen(req,timeout=30) as r:d=json.load(r)
   except urllib.error.HTTPError as e:raise BridgeError('Feishu update HTTP '+str(e.code))
   if d.get('code')!=0:raise BridgeError('Feishu update failed '+str(d.get('code')))
   return matches[0]
  if not allow_create:raise BridgeError('Uncertain Base create is not visible yet; reconcile only, no new POST')
  self.post_started=True
  return self.api(path,{'fields':fields})['data']['record']['record_id']
def load_projects(path):
 raw=json.loads(Path(path).read_text());return raw['projects']
def _sync_locked(bridge,base,p):
 bridge.project(p);out=[]
 for row in bridge.db.execute('select * from requests where project=? and state=?',(p,'created')).fetchall():
  req=json.loads(row['payload']);snap=json.loads(row['snapshot'] or '{}');r=bridge.result(row);t=int(datetime.datetime.now().timestamp()*1000)
  fields={'需求ID':row['request_id'],'项目标识':p,'标题':req['title'],'来源':'Hermes','状态':'等待人工审核' if 'Auto' not in snap.get('labels',[]) else '已加Auto；执行状态待确认','审核状态':'待人工Auto审核' if 'Auto' not in snap.get('labels',[]) else 'GitHub Auto标签已存在','GitHubIssueURL':row['issue_url'],'验收标准':req['acceptance'],'交付摘要':'仅已创建Issue草稿；未自动合并或部署。','阻塞风险':'','创建时间':int(datetime.datetime.fromisoformat(row['created_at']).timestamp()*1000),'更新时间':t}
  if r.get('execution') not in ['unknown','unknown_stale']:
   fields['状态']='本地执行记录：'+r['execution']+'（需复核）'
   fields['交付摘要']='Mac SQLite最后持久记录，不代表Runner当前在线或最新GitHub CI；人工审核前须复核。'
  if r.get('execution')=='unknown_stale':fields['阻塞风险']='执行快照已过期，需重新核验；不得据此报告完成。'
  if r.get('pr_url'):fields['PRURL']=r['pr_url']
  if snap.get('state')=='closed':
   fields['状态']='Issue已关闭（未证明上线）';fields['审核状态']='已关闭，不再等待触发'
  intent=bridge.db.execute('select phase from base_intents where project=? and request_id=?',(p,row['request_id'])).fetchone()
  allow_create=(intent is None)
  if not row['record_id'] and allow_create:
   with bridge.db:bridge.db.execute('insert into base_intents values(?,?,?)',(p,row['request_id'],'posting'))
  try:rec=base.upsert(p,row['request_id'],fields,row['record_id'],allow_create=allow_create)
  except Exception:
   with bridge.db:
    if getattr(base,'post_started',False):bridge.db.execute('update base_intents set phase=? where project=? and request_id=?',('uncertain',p,row['request_id']))
    elif allow_create:bridge.db.execute('delete from base_intents where project=? and request_id=?',(p,row['request_id']))
   raise
  with bridge.db:
   bridge.db.execute('update requests set record_id=?,synced_at=? where project=? and request_id=?',(rec,now(),p,row['request_id']))
   bridge.db.execute('delete from base_intents where project=? and request_id=?',(p,row['request_id']))
  out.append({'project_id':p,'request_id':row['request_id'],'record_id':rec})
 return out
def sync(bridge,base,p):
 if not (base.m.get('base_token') or base.m.get('app_token')):raise BridgeError('Base not provisioned; verify tenant application permissions and run provision_base.py')
 import fcntl
 with open(bridge.db_path+'.sync.lock','a') as lock:
  os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX)
  try:return _sync_locked(bridge,base,p)
  finally:fcntl.flock(lock,fcntl.LOCK_UN)
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--config',default='/srv/hermes/integrations/projects.json');ap.add_argument('--db',default='/srv/hermes/integrations/requests.sqlite');ap.add_argument('--project',required=True);ap.add_argument('action',choices=['create','list','refresh','sync','base-read']);ap.add_argument('--file');ap.add_argument('--table',choices=['projects','requests','metrics'],default='requests');a=ap.parse_args()
 b=Bridge(Path(a.db),load_projects(a.config),Github())
 try:
  if a.action=='create':
   if not a.file:raise BridgeError('--file required')
   result=b.create(a.project,json.loads(Path(a.file).read_text()))
  elif a.action=='list':result=b.list(a.project)
  elif a.action=='refresh':result=b.refresh(a.project)
  else:
   m=json.loads(Path('/srv/hermes/integrations/base-manifest.json').read_text());b.project(a.project);base=Base(m,'/root/.hermes/.env');result=base.read_project(a.project,a.table) if a.action=='base-read' else sync(b,base,a.project)
  print(json.dumps(result,ensure_ascii=False))
 except (BridgeError,KeyError,ValueError) as e:print(json.dumps({'error':str(e)},ensure_ascii=False));return 1
 finally:b.close()
 return 0
if __name__=='__main__':sys.exit(main())
