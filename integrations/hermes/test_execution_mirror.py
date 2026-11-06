import tempfile,unittest
from pathlib import Path
from receive_execution import ingest
class Tests(unittest.TestCase):
 def test_scope_version_and_old_snapshot(self):
  with tempfile.TemporaryDirectory() as t:
   db=Path(t)/'x.db';p={'usmapgames':{'repository_id':1444221313,'repository':'blackpill/usmapgames.com'}}
   e={'repository_id':1444221313,'issue_number':9,'task_id':'uuid','stage':'DEVELOPING','version':3}
   self.assertEqual(ingest(db,p,[e]),1)
   self.assertEqual(ingest(db,p,[dict(e,version=2)]),0)
   with self.assertRaises(ValueError):ingest(db,p,[dict(e,repository_id=1)])
   with self.assertRaises(ValueError):ingest(db,p,[dict(e,stage='DEPLOYED')])

class LockTests(unittest.TestCase):
 def test_write_lock_precedes_version_read(self):
  from unittest.mock import patch
  import receive_execution as mod
  original=mod.sqlite3.connect;trace=[]
  def connect(*args,**kwargs):
   c=original(*args,**kwargs);c.set_trace_callback(trace.append);return c
  with tempfile.TemporaryDirectory() as t,patch.object(mod.sqlite3,'connect',side_effect=connect):
   p={'usmapgames':{'repository_id':1444221313,'repository':'blackpill/usmapgames.com'}}
   ingest(Path(t)/'x.db',p,[{'repository_id':1444221313,'issue_number':9,'task_id':'uuid','stage':'DEVELOPING','version':3}])
  sql='\n'.join(trace).lower();self.assertIn('begin immediate',sql);self.assertLess(sql.index('begin immediate'),sql.index('select task,version'))

if __name__=='__main__':unittest.main()
