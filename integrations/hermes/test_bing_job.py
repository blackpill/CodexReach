import importlib.util,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('job',Path(__file__).with_name('bing_job.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_success(self):
  with patch.object(m,'collect',return_value=0),patch.object(m,'publish',return_value=0),patch.object(m,'notify') as n:self.assertEqual(m.main(),0);n.assert_not_called()
 def test_collection_error(self):
  with patch.object(m,'collect',return_value=1),patch.object(m,'publish') as p,patch.object(m,'notify',return_value=True) as n:self.assertEqual(m.main(),1);p.assert_not_called();n.assert_called_once_with('采集')
 def test_publishing_error(self):
  with patch.object(m,'collect',return_value=0),patch.object(m,'publish',return_value=1),patch.object(m,'notify',return_value=True) as n:self.assertEqual(m.main(),1);n.assert_called_once_with('表格同步')
if __name__=='__main__':unittest.main()
