import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('gsc_sheets',Path(__file__).with_name('gsc_sheets.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def snapshot():
 x={'project_id':'classgames','site_url':'sc-domain:classgames.net','quality':'ok','data_state':'final','captured_at':'2026-11-06T00:00:00Z','periods':{}}
 for p in ['current','previous']:
  d={'start_date':'2026-10-07','end_date':'2026-11-03'}
  for k in ['total','daily','queries','pages','countries','devices']:
   d[k]={'rows':[{'keys':([] if k=='total' else ['=untrusted']),'clicks':1,'impressions':5,'ctr':0.2,'position':2.4}]}
  x['periods'][p]=d
 return x
class SheetsTests(unittest.TestCase):
 def test_projection_all_periods_and_kinds(self):
  rows=m.project(snapshot());self.assertEqual(len(rows),12);self.assertEqual(rows[0][4],'total');self.assertEqual(rows[0][6:10],[1,5,0.2,2.4]);self.assertTrue(any(r[5]=='=untrusted' for r in rows))
 def test_link_rich_text_normalized(self):
  self.assertEqual(m.normalize_cell([{"type":"url","text":"https://classroom"},{"type":"text","text":" games"}]),"https://classroom games")
  self.assertEqual(m.normalize_cell(123),123)
 def test_wrong_project_rejected(self):
  x=snapshot();x['project_id']='other'
  with self.assertRaises(ValueError):m.project(x)
 def test_nonfinal_or_incomplete_rejected(self):
  x=snapshot();x['quality']='error'
  with self.assertRaises(ValueError):m.project(x)
  x=snapshot();del x['periods']['current']['pages']
  with self.assertRaises((KeyError,ValueError)):m.project(x)
 def test_duplicate_dimensions_rejected(self):
  x=snapshot();x['periods']['current']['pages']['rows']*=2
  with self.assertRaises(ValueError):m.project(x)
if __name__=='__main__':unittest.main()
