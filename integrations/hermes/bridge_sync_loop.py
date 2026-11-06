"""Projection-only background worker. Never creates Issues or changes labels."""
import datetime,json,subprocess,time
from pathlib import Path
I=Path('/srv/hermes/integrations')
while True:
 for project in ['usmapgames','classgames']:
  outcomes={}
  for action in ['refresh','sync']:
   try:
    r=subprocess.run(['python3',str(I/'project_bridge.py'),'--project',project,action],capture_output=True,text=True,timeout=120)
    outcomes[action]={'exit':r.returncode,'result':r.stdout.strip()[:1200]}
   except subprocess.TimeoutExpired:outcomes[action]={'exit':124,'error':'timeout; no automatic side-effect retry outside idempotent bridge'}
  p=I/(project+'-sync-status.json');tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps({'project_id':project,'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'outcomes':outcomes},ensure_ascii=False));tmp.chmod(0o600);tmp.replace(p)
 time.sleep(60)
