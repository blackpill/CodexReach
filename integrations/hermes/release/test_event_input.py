import json,tempfile,unittest
from pathlib import Path
from integrations.hermes.release.event_input import read_ticket_from_event
class EventInputTests(unittest.TestCase):
 def test_event_not_environment_is_authoritative_and_malformed_is_rejected(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td)/'event.json';p.write_text(json.dumps({'inputs':{'approval_ticket':'a.b.c'}}))
   self.assertEqual(read_ticket_from_event(p),'a.b.c')
   for bad in [None,{},'bad','a.b.c\n::warning::bad','x'*12001]:
    p.write_text(json.dumps({'inputs':{'approval_ticket':bad}}))
    with self.subTest(bad=type(bad).__name__),self.assertRaises(ValueError):read_ticket_from_event(p)
