"""Receive read-only Mac execution snapshots via authenticated SSH; no queue controls."""
from pathlib import Path
import datetime,json,sqlite3,sys,re
STAGES={'RECEIVED','PREPARING','DEVELOPING','VALIDATING','CREATING_PR','CI_CHECKING','PR_READY','PAUSED','WAITING_QUOTA','BLOCKED'}
def ingest(path,projects,events):
 if not isinstance(events,list) or len(events)>1000:raise ValueError('Invalid snapshot batch')
 repos={str(v['repository_id']):p for p,v in projects.items()};validated=[]
 for e in events:
  repo=str(e.get('repository_id'));p=repos.get(repo)
  if not p or e.get('stage') not in STAGES:raise ValueError('Unknown repository or stage')
  for key in ['issue_number','version']:
   if type(e.get(key)) is not int or e[key]< (1 if key=='issue_number' else 0):raise ValueError('Invalid identity/version')
  if not isinstance(e.get('task_id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',e['task_id']):raise ValueError('Invalid task identity')
  safe={k:e.get(k) for k in ['repository_id','issue_number','task_id','stage','version','thread_id','turn_id','pr_number','head_sha','observed_at']}
  if safe.get('pr_number') is not None and (type(safe['pr_number']) is not int or safe['pr_number']<1):raise ValueError('Invalid PR')
  if safe.get('head_sha') is not None and not re.fullmatch('[0-9a-f]{40}',safe['head_sha']):raise ValueError('Invalid SHA')
  safe['project_id']=p;validated.append(safe)
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);c=sqlite3.connect(path);c.execute('pragma journal_mode=wal')
 c.execute('create table if not exists executions(project text,issue integer,task text,version integer,payload text,last_seen text,primary key(project,issue))');changed=0
 with c:
  c.execute('BEGIN IMMEDIATE')
  for e in validated:
   old=c.execute('select task,version,payload from executions where project=? and issue=?',(e['project_id'],e['issue_number'])).fetchone()
   payload=json.dumps(e,sort_keys=True)
   if old and (old[0]!=e['task_id']):raise ValueError('Conflicting task identity; generation approval required')
   if old and old[1]>e['version']:continue
   if old and old[1]==e['version']:
    # observed_at changes are heartbeat metadata, not a new execution transition.
    before=json.loads(old[2]);before.pop('observed_at',None);after=e.copy();after.pop('observed_at',None)
    if before!=after:raise ValueError('Conflicting same-version state')
    c.execute('update executions set last_seen=? where project=? and issue=?',(datetime.datetime.now(datetime.timezone.utc).isoformat(),e['project_id'],e['issue_number']));continue
   c.execute('insert into executions values(?,?,?,?,?,?) on conflict(project,issue) do update set version=excluded.version,payload=excluded.payload,last_seen=excluded.last_seen',(e['project_id'],e['issue_number'],e['task_id'],e['version'],payload,datetime.datetime.now(datetime.timezone.utc).isoformat()));changed+=1
 c.close();path.chmod(0o600);return changed
if __name__=='__main__':
 try:
  raw=sys.stdin.buffer.read(1024*1024+1)
  if len(raw)>1024*1024:raise ValueError('Oversize batch')
  projects=json.loads(Path('/srv/hermes/integrations/projects.json').read_text())['projects']
  n=ingest('/srv/hermes/integrations/executions.sqlite',projects,json.loads(raw));print(json.dumps({'persisted':True,'changed':n}))
 except (ValueError,KeyError) as e:print(json.dumps({'error':str(e)}));sys.exit(1)
