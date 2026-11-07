import hashlib,json
from .transport import request
class CloudflareReadClient:
 def __init__(self,config,token,transport=request):self.config=config;self.token=token;self.transport=transport
 def _get(self,path):
  d=self.transport('GET',f'https://api.cloudflare.com/client/v4/accounts/{self.config.account_id}/workers/scripts/classgames/'+path,None,{'Authorization':'Bearer '+self.token})
  if d.get('success') is not True:raise ValueError('Cloudflare read unavailable')
  if isinstance(d.get('result'),list) and d.get('result_info',{}).get('total_count',len(d['result']))>len(d['result']):raise ValueError('Incomplete Cloudflare pagination')
  return d['result']
 def snapshot(self):
  dep=self._get('deployments')['deployments'][0];versions=dep['versions']
  if len(versions)!=1 or versions[0].get('percentage')!=100:raise ValueError('Split traffic unsupported')
  vid=versions[0]['version_id'];v=self._get('versions/'+vid);s=self._get('settings')
  if v.get('id')!=vid or s.get('compatibility_date')!='2026-07-31' or s.get('compatibility_flags') or s.get('bindings')!=[{'name':'ASSETS','type':'assets'}]:raise ValueError('Runtime configuration drift')
  runtime=v.get('resources',{}).get('script_runtime',{}).get('assets',{})
  if runtime.get('not_found_handling')!='404-page' or runtime.get('raw_run_worker_first') is not True:raise ValueError('Asset configuration drift')
  domains=self._get('domains/records?environment=production&per_page=500')
  expected={'classgames.net','www.classgames.net'}
  if len(domains)!=2 or {x.get('hostname') for x in domains}!=expected or any(x.get('enabled') is not True or x.get('service')!='classgames' or x.get('environment')!='production' or x.get('zone_id')!='3a05bbc484d36da05b864c2a509c6a0b' for x in domains):raise ValueError('Production domain ownership changed')
  domain_state=sorted([{k:x.get(k) for k in ['hostname','enabled','service','environment','zone_id']} for x in domains],key=lambda x:x['hostname'])
  stable={k:s.get(k) for k in ['compatibility_date','compatibility_flags','bindings','observability','placement']}
  stable['domains']=domain_state
  return {'version_id':vid,'deployment_id':dep['id'],'source_sha':None,'config_digest':hashlib.sha256(json.dumps(stable,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
 def health(self,sha):
  d=self.transport('GET','https://classgames.net/__release.json?sha='+sha,None,{'Cache-Control':'no-cache'})
  from .smoke import smoke
  return d=={'sha':sha} and smoke()
