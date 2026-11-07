import time,unittest,tempfile
from pathlib import Path
from integrations.hermes.release import test_tickets
from integrations.hermes.release.tickets import sign_ticket
from integrations.hermes.release.deploy_tools.runner import run_release
from integrations.hermes.release.config import production_config
from integrations.hermes.release.manifest import digest
class RollbackTests(unittest.TestCase):
 def test_signed_rollback_reuses_version_without_build_or_package(self):
  t=test_tickets.TicketTests();t.setUp();vid='11111111-1111-4111-8111-111111111111';a={**t.a,'operation':'rollback','target_version':vid,'config_digest':digest(production_config())};ticket=sign_ticket(a,t.pem);calls=[]
  def deploy():calls.append('rollback');return {'version_id':vid}
  result=run_release(Path('/does-not-exist'),'a'*40,'r1','5',ticket,t.pub,lambda a:{'granted':True},deploy,lambda:{'version_id':vid,'deployment_id':'d'},lambda s:True,t.now)
  self.assertEqual(calls,['rollback']);self.assertEqual(result['operation'],'rollback');self.assertEqual(result['health_status'],'healthy')
