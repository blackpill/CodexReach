import json, tempfile, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from integrations.hermes.release.config import load_config
from integrations.hermes.release.store import Store

class StoreTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.path=Path(self.tmp.name)/'private'/'state.sqlite'; self.s=Store(self.path)
  self.m={'release_id':'r1','operation':'deploy','repository_id':1223017142,'target_sha':'a'*40,'prepared_at':100,'expires_at':700}
 def tearDown(self): self.s.close(); self.tmp.cleanup()
 def test_disabled_config_and_project_deny(self):
  p=Path(self.tmp.name)/'config.json';p.write_text('{}');c=load_config(p)
  self.assertFalse(c.production_enabled);self.assertEqual(c.allowed_users,())
  p.write_text('{"project":"other"}')
  with self.assertRaises(ValueError):load_config(p)
 def test_pending_unique_and_expiry(self):
  self.s.prepare(self.m)
  with self.assertRaises(ValueError):self.s.prepare({**self.m,'release_id':'r2'})
  with self.assertRaises(ValueError):self.s.approve('r1','om_1','ou_owner',701)
 def test_claim_is_single_attempt_across_reopen(self):
  self.s.prepare(self.m);self.s.approve('r1','om_1','ou_owner',101)
  self.s.transition('r1','APPROVED','DISPATCHED',{'run_id':'5'})
  self.s.claim('r1','5',1,102);self.s.close();self.s=Store(self.path)
  with self.assertRaises(ValueError):self.s.claim('r1','5',1,103)
  self.assertEqual(self.path.stat().st_mode&0o777,0o600)
 def test_concurrent_claim_only_one_winner(self):
  self.s.prepare(self.m);self.s.approve('r1','om_1','ou_owner',101);self.s.transition('r1','APPROVED','DISPATCHED',{'run_id':'5'})
  def claim(_):
   s=Store(self.path)
   try:s.claim('r1','5',1,102);return True
   except ValueError:return False
   finally:s.close()
  with ThreadPoolExecutor(2) as ex:self.assertEqual(sum(ex.map(claim,range(2))),1)
 def test_rerun_and_wrong_run_rejected(self):
  self.s.prepare(self.m);self.s.approve('r1','om_1','ou_owner',101);self.s.transition('r1','APPROVED','DISPATCHED',{'run_id':'5'})
  for run,attempt in [('6',1),('5',2)]:
   with self.assertRaises(ValueError):self.s.claim('r1',run,attempt,102)
 def test_state_cannot_skip_or_regress(self):
  self.s.prepare(self.m)
  with self.assertRaises(ValueError):self.s.transition('r1','PREPARED','HEALTHY',{})
