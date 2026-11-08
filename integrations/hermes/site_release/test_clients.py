import unittest
from .config import ReleaseConfig,production_config
from .test_core import A,B,SHA
from .cloudflare import CloudflareReadClient
from .manifest import prepare_manifest,verified_head
class Gh:
 def __init__(self,t=A):self.t=t;self.workflow_ok=True
 def repository(self):return {'id':self.t.repository_id,'full_name':self.t.repository}
 def main_head(self):return SHA
 def checks(self,sha):return [{'name':name,'head_sha':sha,'status':'completed','conclusion':'success','app':{'id':15368}} for name in ['verify','release-contracts']]
 def verified_workflow(self,sha):return self.workflow_ok
 def changes(self,a,b):return []
class CfFixture:
 def __init__(self,t):self.t=t;self.config=production_config(t);self.binding=[{'name':'ASSETS','type':'assets'}];self.domains=[{'hostname':h,'service':t.worker,'environment':'production','zone_id':t.zone_id,'enabled':True} for h in t.domains]
 def request(self,method,url,data=None,headers=None):
  if 'domains/records' in url:d=self.domains
  elif url.endswith('deployments'):d={'deployments':[{'id':'dep','versions':[{'version_id':'11111111-1111-1111-1111-111111111111','percentage':100}]}]}
  elif '/versions/' in url:d={'id':'11111111-1111-1111-1111-111111111111','resources':{'script_runtime':{'assets':{'not_found_handling':'404-page','raw_run_worker_first':True,**({'html_handling':'force-trailing-slash'} if self.t==A else {})}}}}
  else:d={'compatibility_date':self.t.compatibility_date,'bindings':self.binding,'observability':None if self.t==A else {'enabled':True}}
  return {'success':True,'result':d}
class ClientTests(unittest.TestCase):
 def test_exact_bindings_domains_and_unknown_legacy(self):
  for t in [A,B]:
   f=CfFixture(t)
   if t==B:f.binding.append({'name':'COLORING_ASSETS','type':'r2_bucket','bucket_name':'colorearmundo-assets'})
   c=CloudflareReadClient(ReleaseConfig(t),'fake',f.request);self.assertIsNone(c.snapshot()['source_sha'])
   self.assertTrue(prepare_manifest(ReleaseConfig(t),Gh(t),c,100)['baseline_unmapped'])
   f.binding.append({'name':'EVIL','type':'kv_namespace'})
   with self.assertRaises(ValueError):c.snapshot()
 def test_wrong_bucket_and_domain(self):
  f=CfFixture(B);f.binding.append({'name':'COLORING_ASSETS','type':'r2_bucket','bucket_name':'other'});c=CloudflareReadClient(ReleaseConfig(B),'fake',f.request)
  with self.assertRaises(ValueError):c.snapshot()
  f=CfFixture(A);f.domains[0]['zone_id']=B.zone_id
  with self.assertRaises(ValueError):CloudflareReadClient(ReleaseConfig(A),'fake',f.request).snapshot()
 def test_main_requires_push_workflow_not_just_checks(self):
  g=Gh();g.workflow_ok=False
  with self.assertRaises(ValueError):verified_head(ReleaseConfig(A),g)
