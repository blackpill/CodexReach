import unittest,tempfile,json
from pathlib import Path
from project_bridge import Bridge, BridgeError
class Github:
 def __init__(self):self.created=[]
 def repository(self,repo):return {'id':1444221313,'full_name':repo}
 def create(self,repo,payload):
  self.created.append(payload);return {'number':321,'html_url':f'https://github.com/{repo}/issues/321','labels':[]}
 def issue(self,repo,number):return {'number':number,'html_url':f'https://github.com/{repo}/issues/{number}','state':'open','labels':[]}
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.gh=Github();self.b=Bridge(Path(self.tmp.name)/'state.sqlite',{'usmapgames':{'repository_id':1444221313,'repository':'blackpill/usmapgames.com'}},self.gh)
 def tearDown(self):self.b.close();self.tmp.cleanup()
 def request(self,**kw):return {'request_id':'test_001','title':'草稿验收','body':'无需开发。等待人工审核。','acceptance':'人工确认',**kw}
 def test_no_auto_and_idempotent(self):
  a=self.b.create('usmapgames',self.request());b=self.b.create('usmapgames',self.request())
  self.assertEqual(a['issue_url'],b['issue_url']);self.assertEqual(len(self.gh.created),1);self.assertNotIn('labels',self.gh.created[0]);self.assertEqual(a['approval'],'pending_human_Auto')
 def test_changed_request_rejected(self):
  self.b.create('usmapgames',self.request())
  with self.assertRaises(BridgeError):self.b.create('usmapgames',self.request(body='changed'))
 def test_unknown_project_rejected(self):
  with self.assertRaises(BridgeError):self.b.create('other',self.request())
  self.assertEqual(self.gh.created,[])
 def test_repository_identity_mismatch(self):
  self.gh.repository=lambda _: {'id':1,'full_name':'blackpill/usmapgames.com'}
  with self.assertRaises(BridgeError):self.b.create('usmapgames',self.request())
  self.assertEqual(self.gh.created,[])
 def test_ambiguous_post_never_retried(self):
  def fail(*_):raise TimeoutError('unknown result')
  self.gh.create=fail
  with self.assertRaises(BridgeError):self.b.create('usmapgames',self.request())
  with self.assertRaises(BridgeError):self.b.create('usmapgames',self.request())
 def test_cannot_change_project_with_body(self):
  with self.assertRaises(BridgeError):self.b.create('usmapgames',self.request(project_id='classgames'))
 def test_snapshot_requires_no_claims_of_execution(self):
  a=self.b.create('usmapgames',self.request());self.assertEqual(a['execution'],'unknown');self.assertIsNone(a.get('pr_url'))

class SyncTests(unittest.TestCase):
 setUp=Tests.setUp
 tearDown=Tests.tearDown
 request=Tests.request
 def test_refresh_label_is_not_execution_success(self):
  self.b.create('usmapgames',self.request());self.gh.issue=lambda repo,n:{'number':n,'html_url':f'https://github.com/{repo}/issues/{n}','state':'open','labels':[{'name':'Auto'}]}
  out=self.b.refresh('usmapgames');self.assertEqual(out[0]['execution'],'unknown');self.assertEqual(self.b.list('usmapgames')[0]['approval'],'Auto_label_present')

class MirrorTests(unittest.TestCase):
 setUp=Tests.setUp
 tearDown=Tests.tearDown
 request=Tests.request
 def test_mac_snapshot_is_read_only_execution_evidence(self):
  from receive_execution import ingest
  self.b.create('usmapgames',self.request())
  ingest(Path(self.tmp.name)/'executions.sqlite',self.b.projects,[{'repository_id':1444221313,'issue_number':321,'task_id':'uuid','version':12,'stage':'PR_READY','pr_number':4,'head_sha':'a'*40}])
  r=self.b.list('usmapgames')[0]
  self.assertEqual(r['execution'],'PR_READY');self.assertEqual(r['pr_url'],'https://github.com/blackpill/usmapgames.com/pull/4')

class ProjectionTests(unittest.TestCase):
 setUp=Tests.setUp
 tearDown=Tests.tearDown
 request=Tests.request
 def test_projection_retains_receipt_and_manual_approval(self):
  from project_bridge import sync
  class FakeBase:
   m={'base_token':'test'}
   def __init__(self):self.rows={};self.calls=[]
   def upsert(self,p,rid,fields,known_record=None,allow_create=True):
    self.calls.append((p,rid,fields,known_record));self.rows[(p,rid)]='rec1';return 'rec1'
  base=FakeBase();self.b.create('usmapgames',self.request());sync(self.b,base,'usmapgames');sync(self.b,base,'usmapgames')
  self.assertEqual(len(base.rows),1);self.assertEqual(base.calls[1][3],'rec1');self.assertEqual(base.calls[0][2]['审核状态'],'待人工Auto审核');self.assertEqual(self.b.list('usmapgames')[0]['base_record_id'],'rec1')

class ProjectionFailureTests(unittest.TestCase):
 setUp=Tests.setUp
 tearDown=Tests.tearDown
 request=Tests.request
 def test_uncertain_base_create_is_reconciled_without_second_post(self):
  from project_bridge import sync
  class FakeBase:
   m={'base_token':'test'}
   def __init__(self):self.post_started=False;self.posts=0;self.visible=False
   def upsert(self,p,rid,fields,known_record=None,allow_create=True):
    self.post_started=False
    if self.visible:return 'rec1'
    if not allow_create:raise BridgeError('unknown Base write; not visible yet')
    self.posts+=1;self.post_started=True;raise TimeoutError('response lost after write')
  base=FakeBase();self.b.create('usmapgames',self.request())
  with self.assertRaises(TimeoutError):sync(self.b,base,'usmapgames')
  with self.assertRaises(BridgeError):sync(self.b,base,'usmapgames')
  self.assertEqual(base.posts,1)
  base.visible=True;sync(self.b,base,'usmapgames');self.assertEqual(self.b.list('usmapgames')[0]['base_record_id'],'rec1')

class RefreshIdentityTests(unittest.TestCase):
 setUp=Tests.setUp
 tearDown=Tests.tearDown
 request=Tests.request
 def test_refresh_rechecks_stable_repository_id(self):
  self.b.create('usmapgames',self.request());self.gh.repository=lambda _: {'id':1,'full_name':'blackpill/usmapgames.com'}
  with self.assertRaises(BridgeError):self.b.refresh('usmapgames')

class ClosedProjectionTests(unittest.TestCase):
 setUp=Tests.setUp
 tearDown=Tests.tearDown
 request=Tests.request
 def test_closed_issue_is_not_waiting_for_approval(self):
  from project_bridge import sync
  class FakeBase:
   m={'base_token':'test'}
   def upsert(self,p,rid,fields,known_record=None,allow_create=True):self.fields=fields;return 'rec1'
  self.b.create('usmapgames',self.request());self.gh.issue=lambda repo,n:{'number':n,'html_url':f'https://github.com/{repo}/issues/{n}','state':'closed','labels':[]}
  self.b.refresh('usmapgames');b=FakeBase();sync(self.b,b,'usmapgames');self.assertIn('已关闭',b.fields['状态']);self.assertNotIn('等待',b.fields['状态'])

if __name__=='__main__':unittest.main()

class BaseReadTests(unittest.TestCase):
 def test_base_reads_only_selected_project(self):
  from project_bridge import Base
  b=object.__new__(Base);b.m={'base_token':'base1','tables':{'requests':{'table_id':'tbltest'}}};b.login=lambda:None
  b.api=lambda _: {'data':{'items':[{'record_id':'a','fields':{'项目标识':'usmapgames'}},{'record_id':'b','fields':{'项目标识':'classgames'}}],'has_more':False}}
  self.assertEqual([x['record_id'] for x in b.read_project('usmapgames','requests')],['a'])
