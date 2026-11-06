#!/usr/bin/env python3
"""Collect a classgames Bing Webmaster snapshot with OAuth read scope only."""
import json,os,sys,tempfile,time,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path
SITE='https://classgames.net/'
CREDS=Path('/root/.hermes/credentials/bing-classgames.json')
OUTPUT=Path('/srv/hermes/projects/classgames/metrics/bing/latest.json')
METHODS=('GetRankAndTrafficStats','GetQueryStats','GetPageStats','GetCrawlStats')

def atomic_json(path,value):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd,tmp=tempfile.mkstemp(dir=path.parent,prefix='.bing-',suffix='.tmp')
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,'w',encoding='utf-8') as f:
   json.dump(value,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)

def refresh(path):
 d=json.loads(path.read_text())
 if d.get('scope')!='webmaster.read':raise ValueError('Unexpected OAuth scope')
 payload={k:d[k] for k in ('client_id','client_secret','refresh_token')};payload['grant_type']='refresh_token'
 req=urllib.request.Request('https://www.bing.com/webmasters/oauth/token',data=urllib.parse.urlencode(payload).encode(),headers={'Content-Type':'application/x-www-form-urlencoded'})
 with urllib.request.urlopen(req,timeout=30) as r:token=json.load(r)
 if not token.get('access_token'):raise ValueError('Missing access token')
 if token.get('refresh_token'):
  d['refresh_token']=token['refresh_token'];d.pop('access_token',None);atomic_json(path,d)
 return token['access_token']

def get_report(token,method):
 if method not in METHODS:raise ValueError('Method not allowed')
 url='https://www.bing.com/webmaster/api.svc/json/'+method+'?'+urllib.parse.urlencode({'siteUrl':SITE})
 req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token})
 with urllib.request.urlopen(req,timeout=45) as r:return json.load(r)

def fetch(token):
 result={'source':'bing_webmaster','project_id':'classgames','site_url':SITE,'captured_at':datetime.now(timezone.utc).isoformat(),'quality':'ok','reports':{},'errors':{}}
 for i,method in enumerate(METHODS):
  if i:time.sleep(3)
  body=get_report(token,method)
  if not isinstance(body.get('d'),list):raise ValueError('Invalid Bing result')
  result['reports'][method]=body['d']
 return result

def run(token,output):
 snapshot=fetch(token);atomic_json(output,snapshot);return snapshot

def main():
 try:
  token=refresh(CREDS);data=run(token,OUTPUT)
  print('Bing collection succeeded, captured=%s, counts=%s' %(data['captured_at'],{k:len(v) for k,v in data['reports'].items()}));return 0
 except Exception as e:
  print('Bing collection failed: %s status=%s' %(type(e).__name__,getattr(e,'code',None)),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
