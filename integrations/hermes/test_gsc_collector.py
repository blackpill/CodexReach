import importlib.util
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('gsc_collector.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

class CollectorTests(unittest.TestCase):
    def test_periods_are_previous_28_day_windows(self):
        self.assertEqual(collector.periods(date(2026, 11, 6)), [('current','2026-10-07','2026-11-03'),('previous','2026-09-09','2026-10-06')])
    def test_pagination_and_query_params(self):
        class Response:
            def __init__(self, rows): self.rows=rows
            def raise_for_status(self): pass
            def json(self): return {'rows':self.rows, 'responseAggregationType':'byProperty'}
        class Session:
            def __init__(self): self.calls=[]
            def post(self, url, json, timeout):
                self.calls.append(json.copy()); return Response([{'keys':['x']}]*2 if len(self.calls)==1 else [{'keys':['y']}])
        session=Session()
        with patch.object(collector,'PAGE_SIZE',2):
            result=collector.query(session,'2026-10-07','2026-11-03',['query'])
        self.assertEqual(len(result['rows']),3)
        self.assertEqual(session.calls[1]['startRow'],2)
        self.assertEqual(session.calls[0]['dataState'],'final')
    def test_failed_fetch_never_overwrites_latest(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'latest.json'; p.write_text('original')
            with patch.object(collector,'fetch',side_effect=RuntimeError('failed')):
                with self.assertRaises(RuntimeError): collector.run(None,p,date(2026,11,6))
            self.assertEqual(p.read_text(),'original')
    def test_success_writes_atomic_json(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'latest.json'
            with patch.object(collector,'fetch',return_value={'quality':'ok'}): collector.run(None,p,date(2026,11,6))
            self.assertIn('"quality": "ok"',p.read_text())
            self.assertEqual(p.stat().st_mode & 0o777,0o600)

if __name__ == '__main__': unittest.main()
