import hashlib,json
from .config import production_config,ReleaseConfig
from .transport import request
class CloudflareReadClient:
 def __init__(self,config,token,transport=request):
  self.config=config if isinstance(config,ReleaseConfig) else ReleaseConfig(config);self.token=token;self.transport=transport
 def _get(self,path):
  d=self.transport('GET',f'https://api.cloudflare.com/client/v4/accounts/{self.config.account_id}/workers/scripts/{self.config.worker}/'+path,None,{'Authorization':'Bearer '+self.token})
  if d.get('success') is not True:raise ValueError('Cloudflare read unavailable')
  if isinstance(d.get('result'),list) and d.get('result_info',{}).get('total_count',len(d['result']))>len(d['result']):raise ValueError('Incomplete pagination')
  return d['result']
 def snapshot(self):
  dep=self._get('deployments')['deployments'][0];versions=dep['versions']
  if len(versions)!=1 or versions[0].get('percentage')!=100:raise ValueError('Split traffic unsupported')
  vid=versions[0]['version_id'];v=self._get('versions/'+vid);s=self._get('settings');cfg=production_config(self.config.target)
  expected=[{'name':'ASSETS','type':'assets'}]
  if self.config.project=='colorearmundo':expected.append({'name':'COLORING_ASSETS','type':'r2_bucket','bucket_name':'colorearmundo-assets'})
  bindings=s.get('bindings',[])
  if len(bindings)!=len(expected):raise ValueError('Binding drift')
  normalized=[]
  for b in bindings:
   b=dict(b)
   if 'jurisdiction' in b:
    if b['jurisdiction'] not in (None,'','default'):raise ValueError('R2 jurisdiction drift')
    del b['jurisdiction']
   normalized.append(b)
  if sorted(normalized,key=lambda x:x.get('name',''))!=sorted(expected,key=lambda x:x['name']):raise ValueError('Binding drift')
  if v.get('id')!=vid or s.get('compatibility_date')!=self.config.compatibility_date or s.get('compatibility_flags'):raise ValueError('Runtime drift')
  obs=s.get('observability')
  if (self.config.project=='usmapgames' and obs not in (None,{})) or (self.config.project=='colorearmundo' and (not isinstance(obs,dict) or obs.get('enabled') is not True)):raise ValueError('Observability drift')
  runtime=v.get('resources',{}).get('script_runtime',{}).get('assets',{})
  if runtime.get('not_found_handling')!='404-page' or runtime.get('raw_run_worker_first') is not True:raise ValueError('Asset drift')
  if self.config.project=='usmapgames' and runtime.get('html_handling')!='force-trailing-slash':raise ValueError('HTML handling drift')
  domains=self._get('domains/records?environment=production&per_page=500')
  if len(domains)!=len(self.config.domains) or {x.get('hostname') for x in domains}!=set(self.config.domains) or any(x.get('enabled') is not True or x.get('service')!=self.config.worker or x.get('environment')!='production' or x.get('zone_id')!=self.config.zone_id for x in domains):raise ValueError('Production domain ownership changed')
  stable={k:s.get(k) for k in ['compatibility_date','compatibility_flags','bindings','observability','placement']};stable['domains']=sorted([{k:x.get(k) for k in ['hostname','enabled','service','environment','zone_id']} for x in domains],key=lambda x:x['hostname'])
  return {'version_id':vid,'deployment_id':dep['id'],'source_sha':None,'config_digest':hashlib.sha256(json.dumps(stable,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
 def health(self,sha):
  d=self.transport('GET',self.config.origin+'/__release.json?sha='+sha,None,{'Cache-Control':'no-cache','User-Agent':'SiteReleaseHealth/1.0','Accept':'application/json'})
  from .smoke import smoke
  return d=={'schema':1,'project':self.config.project,'sha':sha} and smoke(self.config.target)
