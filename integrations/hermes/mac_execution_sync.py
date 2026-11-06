"""Read CodexReach SQLite snapshots; push outbound SSH only. No Codex controls."""
import argparse,datetime,json,sqlite3,subprocess,sys
from pathlib import Path
ALLOWED={1444221313,1223017142}
def snapshot(db):
 c=sqlite3.connect('file:'+str(Path(db).resolve())+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 rows=c.execute('select t.repository_id,t.issue_number,t.task_id,p.stage,p.version,p.context from issue_auto_tasks t join issue_auto_progress p on p.task_id=t.task_id').fetchall();c.close();out=[]
 for r in rows:
  if r['repository_id'] not in ALLOWED:continue
  x=json.loads(r['context']);out.append({'repository_id':r['repository_id'],'issue_number':r['issue_number'],'task_id':r['task_id'],'stage':r['stage'],'version':r['version'],'thread_id':x.get('threadId'),'turn_id':x.get('turnId'),'pr_number':x.get('prNumber'),'head_sha':x.get('ciHeadSha') or x.get('commit'),'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 return out
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--db',required=True);ap.add_argument('--dry-run',action='store_true');a=ap.parse_args();events=snapshot(a.db)
 if a.dry_run:print(json.dumps({'snapshots':len(events),'repositories':sorted({e['repository_id'] for e in events})}));sys.exit(0)
 r=subprocess.run(['/usr/bin/ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','root@170.106.172.192','python3 /srv/hermes/integrations/receive_execution.py'],input=json.dumps(events),capture_output=True,text=True,timeout=60)
 if r.returncode:print('execution snapshot delivery failed; source SQLite unchanged',file=sys.stderr);sys.exit(1)
 result=json.loads(r.stdout)
 if result.get('persisted') is not True:raise RuntimeError('no durable receipt')
 print(json.dumps({'snapshot_count':len(events),'receipt':result}))
