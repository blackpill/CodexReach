import hashlib,json,os,re,subprocess,time
from pathlib import Path
from ..config import production_config,ReleaseConfig
from ..manifest import digest
from ..tickets import verify_ticket
from ..event_input import read_ticket_from_event
from ..cloudflare import CloudflareReadClient
from ..transport import request

def verify_package(root,sha):
 root=Path(root)
 if not re.fullmatch('[0-9a-f]{40}',sha) or root.is_symlink():raise ValueError('Invalid package')
 files={}
 for p in root.rglob('*'):
  if p.is_symlink() or not (p.is_file() or p.is_dir()):raise ValueError('Unsafe artifact entry')
  if p.is_file():files[p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
 m=json.loads((root/'manifest.json').read_text());cfg=json.loads((root/'wrangler.json').read_text())
 if cfg!=production_config() or m.get('schema')!=1 or m.get('sha')!=sha or m.get('config_digest')!=digest(cfg):raise ValueError('Package identity mismatch')
 if set(files)!=set(m.get('files',{}))|{'manifest.json'}:raise ValueError('Package file set mismatch')
 for p,h in m['files'].items():
  if not re.fullmatch(r'(bundle\.mjs|wrangler\.json|assets/.+)',p) or any(x in ('.','..','') for x in p.split('/')) or '\\' in p or files.get(p)!=h:raise ValueError('Package content mismatch')
 if json.loads((root/'assets/__release.json').read_text())!={'sha':sha}:raise ValueError('Marker mismatch')
 return m

def run_release(root,sha,release_id,run_id,ticket,public_key,claim,deploy,snapshot,health,now):
 a=verify_ticket(ticket,public_key,now)
 m=verify_package(root,sha) if a['operation']=='deploy' else {'config_digest':digest(production_config()),'sha':sha}
 if a['release_id']!=release_id or a['target_sha']!=sha or a['config_digest']!=m['config_digest']:raise ValueError('Receipt mismatch')
 result={'operation':a['operation'],'release_id':release_id,'run_id':str(run_id),'sha':sha,'artifact_digest':digest(m),'previous_version':a['expected_previous_version'],'version_id':None,'deployment_id':None,'deploy_status':'not_attempted','health_status':'not_checked'}
 # Claim or external uncertainty is never retried here.
 if claim(a).get('granted') is not True:raise ValueError('Claim denied')
 result['deploy_status']='unknown'
 try:
  deployment=deploy()
  if not re.fullmatch(r'[0-9a-f-]{36}',deployment.get('version_id','')):return result
  current=snapshot()
  if current['version_id']!=deployment['version_id']:return result
  result.update(version_id=current['version_id'],deployment_id=current['deployment_id'],deploy_status='deployed')
 except Exception:return result
 try:result['health_status']='healthy' if health(sha) else 'unhealthy'
 except Exception:result['health_status']='unhealthy'
 return result

def main():
 from ..server import approval_claims
 from ..oidc import ISSUER
 env=os.environ
 if env.get('CLASSGAMES_PRODUCTION_RELEASE_ENABLED')!='true':raise ValueError('Production disabled')
 root=Path(env['RELEASE_PACKAGE']).resolve();sha=env['RELEASE_TARGET_SHA'];rid=env['RELEASE_ID'];ticket=read_ticket_from_event(Path(env['GITHUB_EVENT_PATH']));run_id=env['GITHUB_RUN_ID']
 public=env['RELEASE_PUBLIC_KEY'].encode();claims=verify_ticket(ticket,public,int(time.time()))
 # Deployment secret only exists in this step, never installation or website build.
 cf=CloudflareReadClient(ReleaseConfig(),env['CLOUDFLARE_API_TOKEN'])
 claim_url=env['RELEASE_CLAIM_URL']
 if not claim_url.startswith('https://') or not claim_url.endswith('/v1/claims'):raise ValueError('HTTPS claim endpoint required')
 def claim(_):
  url=env['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=classgames-release-control'
  oidc=request('GET',url,None,{'Authorization':'Bearer '+env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})['value']
  return request('POST',claim_url,{'release_id':rid,'ticket':ticket},{'Authorization':'Bearer '+oidc})
 def deploy():
  binary=Path(__file__).parent/'node_modules/.bin/wrangler'
  # Explicit config, no source builds, no retry and no shell. Untrusted stdout is not logged.
  if claims['operation']=='rollback':
   if not re.fullmatch(r'[0-9a-f-]{36}',claims['target_version']):raise ValueError('Invalid rollback version')
   import tempfile
   temp=tempfile.TemporaryDirectory();cfg=Path(temp.name)/'wrangler.json';cfg.write_text(json.dumps({'name':'classgames','account_id':ReleaseConfig().account_id}))
   argv=[str(binary),'versions','deploy',claims['target_version']+'@100%','--yes','--config',str(cfg)];cwd=temp.name
  else:
   argv=[str(binary),'deploy','--config',str(root/'wrangler.json'),'--no-bundle','--strict'];cwd=root
  p=subprocess.run(argv,cwd=cwd,env={k:v for k,v in env.items() if k not in ['RELEASE_TICKET','ACTIONS_ID_TOKEN_REQUEST_TOKEN','RELEASE_PUBLIC_KEY']},capture_output=True,text=True,timeout=600)
  if p.returncode:raise ValueError('Deployment outcome uncertain')
  if claims['operation']=='rollback':return {'version_id':claims['target_version']}
  match=re.search(r'Current Version ID:\s*([0-9a-f-]{36})',p.stdout)
  if not match:raise ValueError('No deployment version evidence')
  return {'version_id':match.group(1)}
 def health(expected):
  # request() refuses redirects. Control-plane version was checked separately.
  d=request('GET','https://classgames.net/__release.json?release='+rid,None,{'Cache-Control':'no-cache'})
  from ..smoke import smoke
  return d=={'sha':expected} and smoke()
 result=run_release(root,sha,rid,run_id,ticket,public,claim,deploy,cf.snapshot,health,int(time.time()))
 Path(env['RELEASE_RESULT']).write_text(json.dumps(result,sort_keys=True)+'\n')
 if result['deploy_status']!='deployed' or result['health_status']!='healthy':raise SystemExit(1)
if __name__=='__main__':main()
