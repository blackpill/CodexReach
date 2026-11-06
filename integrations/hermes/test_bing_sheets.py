import importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('m',Path(__file__).with_name('bing_sheets.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_microsoft_dates(self): self.assertEqual(m.parse_date('/Date(1785542400000)/'),'2026-08-01')
 def test_weekly_uncertain_and_negative_position(self):
  row=m.convert('GetQueryStats',{'Date':'/Date(1785542400000)/','Query':'classgames','Clicks':2,'Impressions':7,'AvgClickPosition':-1},'now')
  self.assertEqual(row[1],'查询词（周数据）');self.assertEqual(row[6],'');self.assertEqual(row[10],'静态快照')
 def test_current_snapshot_labels_itself(self):
  sample={"project_id":"classgames","site_url":"https://classgames.net/","captured_at":"now","quality":"ok","errors":{},"reports":{x:[] for x in m.KINDS}}
  sample["reports"]["GetQueryStats"]=[{"Date":"/Date(1785542400000)/","Query":"x"}]
  self.assertEqual(m.project(sample)[0][10],"已采集")
 def test_reject_wrong_site(self):
  with self.assertRaises(ValueError):m.project({'project_id':'wrong'})
 def test_invalid_date(self):
  with self.assertRaises(ValueError):m.parse_date('bad')
if __name__=='__main__':unittest.main()
