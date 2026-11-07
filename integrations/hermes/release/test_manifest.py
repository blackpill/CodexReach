import unittest
from integrations.hermes.release.config import ReleaseConfig
from integrations.hermes.release.manifest import prepare_manifest,check_baseline
class Gh:
 def repository(self):return {'id':1223017142,'full_name':'blackpill/classgames.net'}
 def main_head(self):return 'a'*40
 def checks(self,sha):return [{'name':'verify','head_sha':sha,'status':'completed','conclusion':'success','app':{'id':15368}}]
 def verified_workflow(self,sha):return True
class Cf:
 def snapshot(self):return {'version_id':'version1','deployment_id':'dep1','source_sha':None,'config_digest':'b'*64}
class ManifestTests(unittest.TestCase):
 def test_unknown_baseline_explicit_and_no_claim_of_complete_diff(self):
  m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),100)
  self.assertTrue(m['baseline_unmapped']);self.assertIsNone(m['source_sha']);self.assertEqual(m['target_sha'],'a'*40);self.assertEqual(m['expires_at'],700)
  check_baseline(m,Gh(),Cf())
 def test_wrong_repo_ci_and_drift_rejected(self):
  for field,value in [('repository',lambda:{'id':1,'full_name':'other'}),('checks',lambda s:[]),('verified_workflow',lambda s:False),('main_head',lambda:'bad')]:
   g=Gh();setattr(g,field,value)
   with self.subTest(field=field),self.assertRaises(ValueError):prepare_manifest(ReleaseConfig(),g,Cf(),100)
  m=prepare_manifest(ReleaseConfig(),Gh(),Cf(),100)
  g=Gh();g.main_head=lambda:'b'*40
  with self.assertRaises(ValueError):check_baseline(m,g,Cf())
  c=Cf();c.snapshot=lambda:{**Cf().snapshot(),'deployment_id':'dep2'}
  with self.assertRaises(ValueError):check_baseline(m,Gh(),c)
