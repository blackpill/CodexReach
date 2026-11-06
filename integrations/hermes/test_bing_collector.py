import importlib.util,json,unittest,tempfile
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('bing_collector',Path(__file__).with_name('bing_collector.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_failed_fetch_does_not_replace_snapshot(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'latest.json';p.write_text('old')
   with patch.object(m,'fetch',side_effect=RuntimeError('failed')):
    with self.assertRaises(RuntimeError):m.run('x',p)
   self.assertEqual(p.read_text(),'old')
 def test_success_atomic_and_private(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'latest.json'
   with patch.object(m,'fetch',return_value={'site_url':'https://classgames.net/'}):m.run('x',p)
   self.assertEqual(json.loads(p.read_text())['site_url'],'https://classgames.net/');self.assertEqual(p.stat().st_mode&0o777,0o600)
 def test_missing_result_fails(self):
  with patch.object(m,'get_report',return_value={'error':'bad'}),patch.object(m.time,'sleep'):
   with self.assertRaises(ValueError):m.fetch('x')
if __name__=='__main__':unittest.main()
