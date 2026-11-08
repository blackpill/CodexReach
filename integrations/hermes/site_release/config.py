"""Closed, immutable target registry. Runtime authorization cannot redirect a target."""
from dataclasses import dataclass
from pathlib import Path
import json,re

@dataclass(frozen=True)
class ReleaseTarget:
 project: str
 repository_id: int
 worker: str
 zone_id: str
 domains: tuple
 chat_id: str
 compatibility_date: str
 sitemap: str
 ci_workflow: str
 port: int
 account_id: str='7daf69e93f12575570a679bb91cc1e76'
 environment: str='production'
 workflow: str='deploy-production.yml'
 @property
 def repository(self):return 'blackpill/'+self.project+'.com'
 @property
 def audience(self):return self.project+'-release-control'
 @property
 def claim_url(self):return 'https://release-control.'+self.project+'.com/v1/claims'
 @property
 def origin(self):return 'https://'+self.project+'.com'
 @property
 def home(self):return Path('/srv/hermes/release-control-'+self.project)
 @property
 def socket(self):return '/run/'+self.project+'-release/control.sock'
_TARGETS=(ReleaseTarget('usmapgames',1444221313,'usmapgames-preview','ca4748ef20171b92930122de9ed8b726',('usmapgames.com',),'oc_9ef60f6e8069fb46230a30e2bbc17bb4','2026-11-03','/sitemap.xml','issue-auto-ci.yml',9125),ReleaseTarget('colorearmundo',1316936114,'colorearmundo','c11088f63851408026db85262ea07528',('colorearmundo.com','www.colorearmundo.com'),'oc_bde0a8380d3eb57aa0edcf28edb2ffc5','2026-07-29','/sitemap-index.xml','verify.yml',9126))
def get_target(project):
 for t in _TARGETS:
  if t.project==project:return t
 raise ValueError('Unregistered release target')
def production_config(target):
 if target!=get_target(target.project):raise ValueError('Unregistered target configuration')
 d={'name':target.worker,'account_id':target.account_id,'main':'bundle.mjs','no_bundle':True,'compatibility_date':target.compatibility_date,'assets':{'directory':'assets','binding':'ASSETS','not_found_handling':'404-page','run_worker_first':True},'routes':[{'pattern':h,'custom_domain':True} for h in target.domains]}
 if target.project=='usmapgames':d['assets']['html_handling']='force-trailing-slash'
 else:d.update(r2_buckets=[{'binding':'COLORING_ASSETS','bucket_name':'colorearmundo-assets'}],observability={'enabled':True})
 return d
@dataclass(frozen=True)
class ReleaseConfig:
 target: ReleaseTarget
 production_enabled: bool=False
 allowed_users: tuple=()
 tenant_key: str=''
 def __post_init__(self):
  if not isinstance(self.target,ReleaseTarget) or self.target!=get_target(self.target.project):raise ValueError('Unregistered target')
  if type(self.production_enabled) is not bool:raise ValueError('Boolean required')
  if not isinstance(self.allowed_users,tuple) or len(set(self.allowed_users))!=len(self.allowed_users) or any(not isinstance(x,str) or not re.fullmatch(r'ou_[A-Za-z0-9_-]{1,80}',x) for x in self.allowed_users):raise ValueError('Invalid user allowlist')
  if not isinstance(self.tenant_key,str) or len(self.tenant_key)>128:raise ValueError('Invalid tenant')
 def __getattr__(self,key):return getattr(self.target,key)
def load_config(project,path):
 d=json.loads(Path(path).read_text())
 if not isinstance(d,dict) or set(d)-{'production_enabled','allowed_users','tenant_key'}:raise ValueError('Unknown configuration key')
 if 'allowed_users' in d:
  if not isinstance(d['allowed_users'],list):raise ValueError('Invalid allowlist')
  d['allowed_users']=tuple(d['allowed_users'])
 return ReleaseConfig(get_target(project),**d)
