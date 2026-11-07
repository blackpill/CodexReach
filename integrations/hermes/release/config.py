"""Fail-closed ClassGames release configuration, never general command execution."""
import json
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class ReleaseConfig:
 project: str = 'classgames'
 repository: str = 'blackpill/classgames.net'
 repository_id: int = 1223017142
 account_id: str = '7daf69e93f12575570a679bb91cc1e76'
 worker: str = 'classgames'
 chat_id: str = 'oc_0e8427180f15b964018e2f899dd66879'
 environment: str = 'production'
 production_enabled: bool = False
 allowed_users: tuple = ()
 tenant_key: str = ''
 workflow: str = 'deploy-production.yml'
 def __post_init__(self):
  fixed={'project':'classgames','repository':'blackpill/classgames.net','repository_id':1223017142,'account_id':'7daf69e93f12575570a679bb91cc1e76','worker':'classgames','chat_id':'oc_0e8427180f15b964018e2f899dd66879','environment':'production','workflow':'deploy-production.yml'}
  if any(getattr(self,k)!=v for k,v in fixed.items()):raise ValueError('Unregistered release target')
  if type(self.production_enabled) is not bool:raise ValueError('Boolean required')
  if not isinstance(self.allowed_users,tuple) or any(not isinstance(x,str) or not x.startswith('ou_') for x in self.allowed_users):raise ValueError('Invalid user allowlist')

def load_config(path: Path) -> ReleaseConfig:
 d=json.loads(path.read_text()); d['allowed_users']=tuple(d.get('allowed_users',[]))
 if set(d)-set(ReleaseConfig.__dataclass_fields__):raise ValueError('Unknown configuration key')
 return ReleaseConfig(**d)

def production_config():
 return {'name':'classgames','account_id':'7daf69e93f12575570a679bb91cc1e76','main':'bundle.mjs','no_bundle':True,'compatibility_date':'2026-07-31','assets':{'directory':'assets','binding':'ASSETS','not_found_handling':'404-page','run_worker_first':True},'observability':{'enabled':True},'routes':[{'pattern':h,'custom_domain':True} for h in ['classgames.net','www.classgames.net']]}
