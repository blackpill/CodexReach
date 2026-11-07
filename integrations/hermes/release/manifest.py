import hashlib,json,re,secrets
from .config import production_config

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def verified_head(config,gh):
 r=gh.repository();sha=gh.main_head()
 if r.get('id')!=config.repository_id or r.get('full_name')!=config.repository or not re.fullmatch('[0-9a-f]{40}',sha):raise ValueError('Repository identity mismatch')
 checks=gh.checks(sha)
 if not any(x.get('name')=='verify' and x.get('head_sha')==sha and x.get('status')=='completed' and x.get('conclusion')=='success' and x.get('app',{}).get('id')==15368 for x in checks) or not gh.verified_workflow(sha):raise ValueError('Verified main CI required')
 return sha

def prepare_manifest(config,gh,cf,now):
 sha=verified_head(config,gh);s=cf.snapshot()
 if sha!=gh.main_head():raise ValueError('Main changed during preparation')
 return {'release_id':'rel_'+secrets.token_hex(12),'operation':'deploy','repository_id':config.repository_id,'repository':config.repository,'environment':'production','worker':'classgames','target_sha':sha,'target_version':None,'source_sha':s.get('source_sha'),'baseline_unmapped':s.get('source_sha') is None,'expected_previous_version':s['version_id'],'expected_previous_deployment':s['deployment_id'],'baseline_config_digest':s['config_digest'],'config_digest':digest(production_config()),'prepared_at':now,'expires_at':now+600,'nonce':secrets.token_urlsafe(24),'thread_id':None}

def check_baseline(manifest,gh,cf):
 from .config import ReleaseConfig
 sha=verified_head(ReleaseConfig(),gh);s=cf.snapshot()
 if manifest['operation']=='rollback' and sha!=manifest.get('workflow_sha'):raise ValueError('Workflow main changed; prepare again')
 if manifest['operation']=='deploy' and sha!=manifest['target_sha']:raise ValueError('Main changed; prepare again')
 for key,remote in [('expected_previous_version','version_id'),('expected_previous_deployment','deployment_id'),('baseline_config_digest','config_digest')]:
  if manifest[key]!=s[remote]:raise ValueError('Production baseline changed; prepare again')
 if manifest['config_digest']!=digest(production_config()):raise ValueError('Release configuration changed')
