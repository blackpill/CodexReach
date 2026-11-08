import hashlib,json,re,secrets
from .config import production_config

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def verified_head(config,gh):
 r=gh.repository();sha=gh.main_head()
 if r.get('id')!=config.repository_id or r.get('full_name')!=config.repository or not re.fullmatch('[0-9a-f]{40}',sha):raise ValueError('Repository identity mismatch')
 checks=gh.checks(sha)
 if not all(any(x.get('name')==name and x.get('head_sha')==sha and x.get('status')=='completed' and x.get('conclusion')=='success' and x.get('app',{}).get('id')==15368 for x in checks) for name in ('verify','release-contracts')) or not gh.verified_workflow(sha):raise ValueError('Verified main CI required')
 return sha

def prepare_manifest(config,gh,cf,now):
 sha=verified_head(config,gh);s=cf.snapshot()
 if sha!=gh.main_head():raise ValueError('Main changed during preparation')
 return {'schema':1,'project':config.project,'release_id':'rel_'+secrets.token_hex(12),'operation':'deploy','repository_id':config.repository_id,'repository':config.repository,'environment':'production','worker':config.worker,'target_sha':sha,'target_version':None,'source_sha':s.get('source_sha'),'baseline_unmapped':s.get('source_sha') is None,'expected_previous_version':s['version_id'],'expected_previous_deployment':s['deployment_id'],'baseline_config_digest':s['config_digest'],'config_digest':digest(production_config(config.target)),'prepared_at':now,'expires_at':now+600,'nonce':secrets.token_urlsafe(24),'thread_id':None}

def check_baseline(manifest,gh,cf):
 config=cf.config
 if manifest.get('project')!=config.project or manifest.get('repository_id')!=config.repository_id:raise ValueError('Baseline target mismatch')
 sha=verified_head(config,gh);s=cf.snapshot()
 if manifest['operation']=='rollback' and sha!=manifest.get('workflow_sha'):raise ValueError('Workflow main changed; prepare again')
 if manifest['operation']=='deploy' and sha!=manifest['target_sha']:raise ValueError('Main changed; prepare again')
 for key,remote in [('expected_previous_version','version_id'),('expected_previous_deployment','deployment_id'),('baseline_config_digest','config_digest')]:
  if manifest[key]!=s[remote]:raise ValueError('Production baseline changed; prepare again')
 if manifest['config_digest']!=digest(production_config(config.target)):raise ValueError('Release configuration changed')


def rollback_artifact_manifest(target,sha,version):
 return {'schema':1,'operation':'rollback','project':target.project,'repository':target.repository,'repository_id':target.repository_id,'sha':sha,'target_version':version,'config_digest':digest(production_config(target))}

def verify_artifact_manifest(m,target,sha):
 if not isinstance(m,dict) or set(m)!={'schema','project','repository','repository_id','sha','config_digest','files'}:raise ValueError('Invalid manifest schema')
 if type(m['schema']) is not int or m['schema']!=1 or type(m['repository_id']) is not int or any(m[k]!=v for k,v in {'project':target.project,'repository':target.repository,'repository_id':target.repository_id,'sha':sha,'config_digest':digest(production_config(target))}.items()):raise ValueError('Manifest target mismatch')
 files=m['files']
 if not isinstance(files,dict) or not 3<=len(files)<=20000 or not {'bundle.mjs','wrangler.json','assets/__release.json'}<=set(files):raise ValueError('Invalid manifest files')
 for p,h in files.items():
  if not isinstance(p,str) or not re.fullmatch(r'(bundle\.mjs|wrangler\.json|assets/.+)',p) or any(x in ('','..','.') for x in p.split('/')) or '\\' in p or not isinstance(h,str) or not re.fullmatch('[0-9a-f]{64}',h):raise ValueError('Invalid manifest entry')
 return m
