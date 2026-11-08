import json,tempfile,unittest
from pathlib import Path
from .config import get_target,ReleaseConfig,load_config,production_config
class ConfigTests(unittest.TestCase):
 def test_default_disabled_and_empty_allowlist(self):
  for p in ['usmapgames','colorearmundo']:
   c=ReleaseConfig(get_target(p));self.assertFalse(c.production_enabled);self.assertEqual(c.allowed_users,())
 def test_unknown_project_and_override_rejected(self):
  for p in ['classgames','other','../usmapgames']:
   with self.assertRaises(ValueError):get_target(p)
  with tempfile.TemporaryDirectory() as d:
   f=Path(d)/'c';f.write_text(json.dumps({'worker':'evil'}))
   with self.assertRaises(ValueError):load_config('usmapgames',f)
 def test_production_worker_is_preview_not_local_preview(self):
  t=get_target('usmapgames');self.assertEqual(t.worker,'usmapgames-preview');self.assertEqual(t.repository_id,1444221313);self.assertEqual(t.domains,('usmapgames.com',));self.assertEqual(t.sitemap,'/sitemap.xml')
 def test_configs_are_independent(self):
  a=production_config(get_target('colorearmundo'));a['assets']['binding']='evil'
  self.assertEqual(production_config(get_target('colorearmundo'))['r2_buckets'],[{'binding':'COLORING_ASSETS','bucket_name':'colorearmundo-assets'}]);self.assertEqual(production_config(get_target('colorearmundo'))['assets']['binding'],'ASSETS')
