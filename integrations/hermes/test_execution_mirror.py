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

class SnapshotScopeTests(unittest.TestCase):
 def test_export_includes_colorearmundo_but_excludes_unregistered_repository(self):
  import json,sqlite3
  from mac_execution_sync import snapshot
  with tempfile.TemporaryDirectory() as t:
   db=Path(t)/'state.db'
   c=sqlite3.connect(db)
   c.execute('create table issue_auto_tasks (repository_id integer,issue_number integer,task_id text)')
   c.execute('create table issue_auto_progress (task_id text,stage text,version integer,context text)')
   for repo,task in [(1316936114,'color'),(999,'unknown')]:
    c.execute('insert into issue_auto_tasks values(?,?,?)',(repo,1,task))
    c.execute('insert into issue_auto_progress values(?,?,?,?)',(task,'DEVELOPING',1,json.dumps({})))
   c.commit();c.close()
   self.assertEqual([x['repository_id'] for x in snapshot(db)],[1316936114])

class MixedBatchTests(unittest.TestCase):
 def test_receiver_requires_registration_before_accepting_mixed_snapshot_batch(self):
  import sqlite3
  with tempfile.TemporaryDirectory() as t:
   db=Path(t)/'mirror.db'
   projects={'usmapgames':{'repository_id':1444221313,'repository':'blackpill/usmapgames.com'}}
   old={'repository_id':1444221313,'issue_number':9,'task_id':'old','stage':'DEVELOPING','version':1}
   color={'repository_id':1316936114,'issue_number':2,'task_id':'color','stage':'RECEIVED','version':1}
   self.assertEqual(ingest(db,projects,[old]),1)
   with self.assertRaises(ValueError): ingest(db,projects,[dict(old,version=2),color])
   with sqlite3.connect(db) as c:self.assertEqual(c.execute('select version from executions').fetchone()[0],1)
   projects['colorearmundo']={'repository_id':1316936114,'repository':'blackpill/colorearmundo.com'}
   self.assertEqual(ingest(db,projects,[dict(old,version=2),color]),2)
   with sqlite3.connect(db) as c:self.assertEqual(c.execute('select count(*) from executions').fetchone()[0],2)

if __name__=='__main__':unittest.main()
