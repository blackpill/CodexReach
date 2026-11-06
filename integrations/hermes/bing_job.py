#!/usr/bin/env python3
"""Collect Bing data, publish to Feishu, and report failures to the project group."""
import json,os,subprocess,sys
CHAT_ID='oc_0e8427180f15b964018e2f899dd66879'

def notify(stage,test=False):
 try:
  from provision_base import load_credentials
  from gsc_job import post
  creds=load_credentials();auth=post('auth/v3/tenant_access_token/internal',{'app_id':creds['FEISHU_APP_ID'],'app_secret':creds['FEISHU_APP_SECRET']})
  message='【测试】classgames Bing 告警通道验证，非真实故障。' if test else '【%s失败】classgames.net Bing Webmaster 任务失败。快照或表格可能未更新，表格可能部分新旧混合，请检查日志及授权。' % stage
  post('im/v1/messages?receive_id_type=chat_id',{'receive_id':CHAT_ID,'msg_type':'text','content':json.dumps({'text':message},ensure_ascii=False)},auth['tenant_access_token'])
  print('Bing Feishu notification accepted');return True
 except Exception as e:
  print('Bing notification failed: '+type(e).__name__,file=sys.stderr);return False

def collect():return subprocess.run(['/usr/bin/python3','/srv/hermes/integrations/bing_collector.py'],timeout=600,check=False).returncode

def publish():
 env=os.environ.copy();env['PYTHONPATH']='/root/data-stats-scripts'
 return subprocess.run(['/usr/bin/python3','/srv/hermes/integrations/bing_sheets.py'],timeout=1800,check=False,env=env).returncode

def main():
 stage='采集'
 try:
  code=collect()
  if not code:stage='表格同步';code=publish()
 except Exception as e:
  print('Bing task failed: '+type(e).__name__,file=sys.stderr);code=1
 if code:
  if not notify(stage):print('ALERT DELIVERY FAILED',file=sys.stderr)
  return 1
 return 0
if __name__=='__main__':
 sys.exit(0 if len(sys.argv)==2 and sys.argv[1]=='--test-notification' and notify('测试',test=True) else (1 if len(sys.argv)>1 else main()))
