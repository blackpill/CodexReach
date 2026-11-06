#!/usr/bin/env python3
"""Run GSC collector and notify the classgames project group on failure."""
import json
import os
import subprocess
import sys
import urllib.request

CHAT_ID = 'oc_0e8427180f15b964018e2f899dd66879'
BASE = 'https://open.feishu.cn/open-apis/'


def post(path, payload, token=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=15) as response:
        result = json.load(response)
    if result.get('code') != 0: raise RuntimeError('Feishu API rejected request, code=%s' % result.get('code'))
    return result


def notify(test=False, stage="采集"):
    try:
        from provision_base import load_credentials
        env = load_credentials()
        auth = post('auth/v3/tenant_access_token/internal', {'app_id': env['FEISHU_APP_ID'], 'app_secret': env['FEISHU_APP_SECRET']})
        message = ('【测试】classgames GSC 告警通道验证，非真实故障。' if test else '【%s失败】classgames.net GSC 任务失败。表格可能未更新或只更新了一部分，请检查云端日志及授权。' % stage)
        post('im/v1/messages?receive_id_type=chat_id', {'receive_id':CHAT_ID, 'msg_type':'text', 'content':json.dumps({'text':message},ensure_ascii=False)}, auth['tenant_access_token'])
        print('Feishu notification accepted')
        return True
    except Exception as exc:
        print('Feishu notification failed: ' + type(exc).__name__, file=sys.stderr)
        return False


def collect():
    return subprocess.run(['/usr/bin/python3','/srv/hermes/integrations/gsc_collector.py'],timeout=900,check=False).returncode


def publish():
    env = os.environ.copy()
    env['PYTHONPATH'] = '/root/data-stats-scripts'
    return subprocess.run(['/usr/bin/python3','/srv/hermes/integrations/gsc_sheets.py'],timeout=1800,check=False,env=env).returncode


def main():
    stage = '采集'
    try:
        status = collect()
        if not status:
            stage = '表格同步'
            status = publish()
    except Exception as exc:
        print('GSC task failed: ' + type(exc).__name__, file=sys.stderr)
        status = 1
    if status:
        if not notify(stage=stage): print('ALERT DELIVERY FAILED: check credentials and chat membership',file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(0 if len(sys.argv)==2 and sys.argv[1]=='--test-notification' and notify(test=True) else (1 if len(sys.argv)>1 else main()))
