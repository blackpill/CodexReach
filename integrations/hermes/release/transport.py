"""Bounded transport; credentials and remote error bodies never reach exceptions."""
import json,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None

def request(method,url,data=None,headers=None):
 h={'Content-Type':'application/json',**(headers or {})}
 req=urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=h,method=method)
 try:
  with urllib.request.build_opener(NoRedirect).open(req,timeout=20) as r:
   raw=r.read(4_000_001)
   if len(raw)>4_000_000:raise ValueError('Remote response too large')
   return json.loads(raw) if raw else {}
 except (urllib.error.URLError,TimeoutError,OSError,json.JSONDecodeError):raise ValueError('Remote API unavailable; no write retry permitted') from None
