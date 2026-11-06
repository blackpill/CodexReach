#!/usr/bin/env python3
"""Publish Bing Webmaster snapshot to a distinct managed Feishu tab."""
import datetime,json,re,sys
from pathlib import Path
TOKEN='OEsMsBFeRhgJxXtPtKNcazb0nve'; TITLE='ShadowBing'
SNAPSHOT=Path('/srv/hermes/projects/classgames/metrics/bing/latest.json')
HEADER=['项目','数据类型','Bing日期标签','维度值','点击','展示','平均点击排名','平均展示排名','抓取页面','抓取错误','状态','采集时间']
KEYS=['项目','数据类型','Bing日期标签','维度值']
KINDS={'GetRankAndTrafficStats':'站点（日数据）','GetQueryStats':'查询词（周数据）','GetPageStats':'页面（周数据）','GetCrawlStats':'抓取（日数据）'}
def parse_date(value):
 m=re.fullmatch(r'/Date\((\d+)\)/',value)
 if not m:raise ValueError('Invalid Bing date')
 return datetime.datetime.fromtimestamp(int(m.group(1))/1000,datetime.timezone.utc).date().isoformat()
def normalize_cell(v):
 if isinstance(v,list) and v and all(isinstance(x,dict) and isinstance(x.get('text'),str) for x in v):return ''.join(x['text'] for x in v)
 return v
def convert(kind,raw,captured,status="静态快照"):
 def metric(k):
  v=raw.get(k,'')
  return '' if v is None or (isinstance(v,(int,float)) and v<0) else v
 return ['classgames',KINDS[kind],parse_date(raw['Date']),raw.get('Query',''),metric('Clicks'),metric('Impressions'),metric('AvgClickPosition'),metric('AvgImpressionPosition'),metric('CrawledPages'),metric('CrawlErrors'),status,captured]
def project(s):
 if s.get('project_id')!='classgames' or s.get('site_url')!='https://classgames.net/' or s.get('errors'):raise ValueError('Invalid or incomplete Bing snapshot')
 captured=s['captured_at']; out=[];seen=set()
 for kind in KINDS:
  for row in s['reports'][kind]:
   r=convert(kind,row,captured,"已采集" if s.get("quality")=="ok" else "静态快照");key=tuple(r[:4])
   if key in seen:raise ValueError('Duplicate key')
   seen.add(key);out.append(r)
 return out

def main():
 try:
  from reporting.config import load_env_file
  from reporting.analytics_sheets import SheetsApi,sync_table
  load_env_file();s=json.loads(SNAPSHOT.read_text());rows=project(s)
  class API(SheetsApi):
   def read(self,token,sheet_id,width):return [[normalize_cell(c) for c in row] for row in super().read(token,sheet_id,width)]
  result=sync_table(API(),TOKEN,TITLE,HEADER,rows,KEYS)
  print('Bing snapshot published; sheet_id=%s rows=%d captured=%s' %(result['sheet_id'],len(rows),s['captured_at']));return 0
 except Exception as e:
  print('Bing sheet publish failed: '+type(e).__name__,file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
