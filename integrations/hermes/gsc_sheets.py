#!/usr/bin/env python3
"""Publish only verified classgames GSC snapshots to a managed Feishu tab."""
import json
import math
import sys
from pathlib import Path

TOKEN = 'OEsMsBFeRhgJxXtPtKNcazb0nve'
TITLE = 'ShadowGSC'
SNAPSHOT = Path('/srv/hermes/projects/classgames/metrics/gsc/latest.json')
HEADER = ['项目', '周期', '区间开始', '区间结束', '维度类型', '维度值', '点击', '展示', '点击率', '平均排名', '采集时间', '数据状态']
KEYS = ['项目', '周期', '维度类型', '维度值']
KINDS = ('total', 'daily', 'queries', 'pages', 'countries', 'devices')


def normalize_cell(value):
    if isinstance(value, list) and value and all(isinstance(x, dict) and isinstance(x.get("text"), str) for x in value):
        return "".join(x["text"] for x in value)
    return value


def project(snapshot):
    if (snapshot.get('project_id'), snapshot.get('site_url'), snapshot.get('quality'), snapshot.get('data_state')) != ('classgames','sc-domain:classgames.net','ok','final'):
        raise ValueError('Unverified project, site, quality or data state')
    captured = snapshot['captured_at']
    if not captured: raise ValueError('Missing capture time')
    result, keys = [], set()
    for period in ('current', 'previous'):
        block = snapshot['periods'][period]
        for kind in KINDS:
            rows = block[kind]['rows']
            if not isinstance(rows, list): raise ValueError('Invalid rows')
            for raw in rows:
                dimension = raw.get('keys', [])
                if not isinstance(dimension, list) or len(dimension) != (0 if kind == 'total' else 1): raise ValueError('Invalid dimension')
                dim = '' if kind == 'total' else dimension[0]
                if not isinstance(dim,str): raise ValueError('Invalid dimension value')
                key = ('classgames', period, kind, dim)
                if key in keys: raise ValueError('Duplicate dimension key')
                keys.add(key)
                values = [raw.get(k) for k in ('clicks','impressions','ctr','position')]
                if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in values): raise ValueError('Invalid metric')
                result.append(['classgames',period,block['start_date'],block['end_date'],kind,dim,*values,captured,'final'])
    return result


def main():
    try:
        from reporting.config import load_env_file
        from reporting.analytics_sheets import SheetsApi, sync_table
        load_env_file()
        snap=json.loads(SNAPSHOT.read_text(encoding='utf-8'))
        rows=project(snap)
        class NormalizedSheetsApi(SheetsApi):
            def read(self, token, sheet_id, width):
                return [[normalize_cell(cell) for cell in row] for row in super().read(token, sheet_id, width)]
        result=sync_table(NormalizedSheetsApi(),TOKEN,TITLE,HEADER,rows,KEYS)
        print('GSC sheet published; sheet_id=%s rows=%s captured=%s' % (result['sheet_id'],len(rows),snap['captured_at']))
        return 0
    except Exception as exc:
        print('GSC sheet publication failed: '+type(exc).__name__,file=sys.stderr)
        return 1


if __name__=='__main__':sys.exit(main())
