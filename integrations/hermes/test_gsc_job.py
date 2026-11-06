import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('job',Path(__file__).with_name('gsc_job.py'))
job=importlib.util.module_from_spec(spec);spec.loader.exec_module(job)
class JobTests(unittest.TestCase):
 def test_success_no_alert(self):
  with patch.object(job,'collect',return_value=0),patch.object(job,'publish',return_value=0),patch.object(job,'notify') as n:
   self.assertEqual(job.main(),0);n.assert_not_called()
 def test_collection_failure_notifies_and_never_publishes(self):
  with patch.object(job,'collect',return_value=1),patch.object(job,'publish') as p,patch.object(job,'notify',return_value=True) as n:
   self.assertEqual(job.main(),1);n.assert_called_once_with(stage='采集');p.assert_not_called()
 def test_publication_failure_notifies(self):
  with patch.object(job,'collect',return_value=0),patch.object(job,'publish',return_value=1),patch.object(job,'notify',return_value=True) as n:
   self.assertEqual(job.main(),1);n.assert_called_once_with(stage='表格同步')
 def test_exception_notifies_without_leaking_exception(self):
  with patch.object(job,'collect',side_effect=RuntimeError('secret')),patch.object(job,'notify',return_value=True) as n:
   self.assertEqual(job.main(),1);self.assertNotIn('secret',str(n.call_args))
if __name__=='__main__':unittest.main()
