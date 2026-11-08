"""SQLite is the one-writer authority; remote uncertainty never permits retry."""
import json,re,sqlite3
from pathlib import Path
from contextlib import contextmanager

TERMINAL={'HEALTHY','CANCELLED','EXPIRED','VALIDATION_FAILED','DEPLOYED_UNHEALTHY'}
EDGES={'APPROVED':{'DISPATCHED','DISPATCH_UNCERTAIN'},'DISPATCH_UNCERTAIN':{'DISPATCHED'},'DISPATCHED':{'VALIDATION_FAILED'},'DEPLOYING':{'DEPLOYED','DEPLOY_UNCERTAIN'},'DEPLOY_UNCERTAIN':{'DEPLOYED'},'DEPLOYED':{'HEALTHY','DEPLOYED_UNHEALTHY'}}
class Store:
 def __init__(self,path,target):
  from .config import get_target
  if target!=get_target(target.project):raise ValueError("Unregistered target")
  self.target=target
  p=Path(path);p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  self.db=sqlite3.connect(p,timeout=10,isolation_level=None);p.chmod(0o600)
  self.db.row_factory=sqlite3.Row
  tables={r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  if 'release_target' in tables:
   if self.db.execute('SELECT project FROM release_target').fetchall()!=[(target.project,)]:
    # sqlite Row values are compared explicitly below.
    rows=self.db.execute('SELECT project FROM release_target').fetchall()
    if len(rows)!=1 or rows[0][0]!=target.project:self.db.close();raise ValueError('Database target mismatch')
  elif 'releases' in tables:self.db.close();raise ValueError('Unscoped existing database')
  self.db.execute('CREATE TABLE IF NOT EXISTS release_target(project TEXT NOT NULL)')
  if not self.db.execute('SELECT project FROM release_target').fetchone():self.db.execute('INSERT INTO release_target VALUES(?)',(target.project,))
  self.db.executescript('CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,state TEXT NOT NULL,manifest TEXT NOT NULL,actor TEXT,message TEXT UNIQUE,approved_at INTEGER,run_id TEXT,claimed INTEGER NOT NULL DEFAULT 0,evidence TEXT NOT NULL DEFAULT "{}");')
  self.db.execute('CREATE TABLE IF NOT EXISTS notices(release_id TEXT,state TEXT,created_at INTEGER,status TEXT NOT NULL DEFAULT "PENDING",attempts INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER,PRIMARY KEY(release_id,state))')
 def close(self): self.db.close()
 @contextmanager
 def transaction(self):
  self.db.execute('BEGIN IMMEDIATE')
  try:yield;self.db.execute('COMMIT')
  except BaseException:self.db.execute('ROLLBACK');raise
 def get(self,rid):
  row=self.db.execute('SELECT * FROM releases WHERE id=?',(rid,)).fetchone()
  if row is None:raise ValueError('Unknown release')
  d=dict(row);d['manifest']=json.loads(d['manifest']);d['evidence']=json.loads(d['evidence']);self.check_scope(d['manifest']);return d
 def check_scope(self,m):
  if any(m.get(k)!=v for k,v in {'schema':1,'project':self.target.project,'repository':self.target.repository,'repository_id':self.target.repository_id,'worker':self.target.worker,'environment':'production'}.items()):raise ValueError('State target mismatch')
 def prepare(self,manifest):
  self.check_scope(manifest)
  if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',manifest.get('release_id','')) or manifest.get('repository_id')!=self.target.repository_id or manifest.get('operation') not in ('deploy','rollback'):raise ValueError('Invalid release')
  with self.transaction():
   active=self.db.execute('SELECT state FROM releases').fetchall()
   if any(r['state'] not in TERMINAL for r in active):raise ValueError('An active release already exists')
   self.db.execute('INSERT INTO releases(id,state,manifest) VALUES(?,"PREPARED",?)',(manifest['release_id'],json.dumps(manifest,sort_keys=True)))
  return self.get(manifest['release_id'])
 def approve(self,rid,message_id,actor_id,now):
  with self.transaction():
   r=self.get(rid);m=r['manifest']
   if r['state']!='PREPARED' or not m['prepared_at']<=now<m['expires_at']:raise ValueError('Not awaiting a valid confirmation')
   try:self.db.execute('UPDATE releases SET state="APPROVED",message=?,actor=?,approved_at=? WHERE id=?',(message_id,actor_id,now,rid))
   except sqlite3.IntegrityError:raise ValueError('Message already consumed') from None
  return self.get(rid)
 def claim(self,rid,run_id,run_attempt,now):
  with self.transaction():
   r=self.get(rid)
   if r['state']!='DISPATCHED' or r['claimed'] or r['run_id']!=str(run_id) or type(run_attempt) is not int or run_attempt!=1 or not r['approved_at']<=now<r['approved_at']+5400:raise ValueError('Claim denied')
   self.db.execute('UPDATE releases SET claimed=1,state="DEPLOYING" WHERE id=?',(rid,))
  return self.get(rid)
 def transition(self,rid,expected_state,next_state,evidence):
  with self.transaction():
   r=self.get(rid)
   if r['state']!=expected_state or next_state not in EDGES.get(expected_state,set()):raise ValueError('Invalid transition')
   run=evidence.get('run_id',r['run_id'])
   self.db.execute('UPDATE releases SET state=?,run_id=?,evidence=? WHERE id=?',(next_state,str(run) if run is not None else None,json.dumps({**r['evidence'],**evidence},sort_keys=True),rid))
  return self.get(rid)
 def note(self,rid,evidence):
  with self.transaction():
   r=self.get(rid);self.db.execute('UPDATE releases SET evidence=? WHERE id=?',(json.dumps({**r['evidence'],**evidence},sort_keys=True),rid))
  return self.get(rid)
 def healthy_version(self,vid):
  for row in self.db.execute('SELECT id FROM releases WHERE state="HEALTHY" ORDER BY approved_at DESC'):
   r=self.get(row['id'])
   if r['evidence'].get('version_id')==vid:return r
  raise ValueError('No verified SHA/version mapping; cannot automate rollback')
 def cancel(self,rid):
  with self.transaction():
   r=self.get(rid)
   if r['state']!='PREPARED':raise ValueError('Cannot cancel an attempted release')
   self.db.execute('UPDATE releases SET state="CANCELLED" WHERE id=?',(rid,))
  return self.get(rid)
 def approve_for_dispatch(self,rid,message_id,actor_id,now):
  with self.transaction():
   r=self.get(rid);m=r['manifest']
   if r['state']!='PREPARED' or not m['prepared_at']<=now<m['expires_at']:raise ValueError('Confirmation expired or consumed')
   try:self.db.execute('UPDATE releases SET state="DISPATCH_UNCERTAIN",message=?,actor=?,approved_at=? WHERE id=?',(message_id,actor_id,now,rid))
   except sqlite3.IntegrityError:raise ValueError('Message already consumed') from None
  return self.get(rid)
 def queue_notice(self,rid,state,now):
  with self.transaction():self.db.execute('INSERT OR IGNORE INTO notices(release_id,state,created_at) VALUES(?,?,?)',(rid,state,now))
 def reserve_notice(self,rid,state,now):
  with self.transaction():
   r=self.db.execute('SELECT * FROM notices WHERE release_id=? AND state=?',(rid,state)).fetchone()
   if not r or r['status'] in ('SENT','GAVE_UP'):return False
   if now-r['created_at']>300 or r['attempts']>=3:
    self.db.execute('UPDATE notices SET status="GAVE_UP" WHERE release_id=? AND state=?',(rid,state));return False
   if r['last_attempt'] is not None and now-r['last_attempt']<30:return False
   self.db.execute('UPDATE notices SET status="IN_FLIGHT",attempts=attempts+1,last_attempt=? WHERE release_id=? AND state=?',(now,rid,state));return True
 def finish_notice(self,rid,state,sent):
  with self.transaction():self.db.execute('UPDATE notices SET status=? WHERE release_id=? AND state=?',('SENT' if sent else 'PENDING',rid,state))
