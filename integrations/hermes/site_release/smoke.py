import urllib.request,urllib.error,re
from .transport import NoRedirect

def probe(target,path):
 if path=='@www':
  req=urllib.request.Request('https://www.'+target.project+'.com/',headers={'User-Agent':'SiteReleaseHealth/1.0'})
  try:r=urllib.request.build_opener(NoRedirect).open(req,timeout=15)
  except urllib.error.HTTPError as e:r=e
  with r:return r.status,r.headers.get('Location',''),'redirect',{}
 if not path.startswith('/') or path.startswith('//'):raise ValueError('Same-origin path required')
 req=urllib.request.Request(target.origin+path,headers={'Cache-Control':'no-cache','User-Agent':'SiteReleaseHealth/1.0'})
 try:r=urllib.request.build_opener(NoRedirect).open(req,timeout=15)
 except urllib.error.HTTPError as e:r=e
 with r:
  # Binary media samples need only a bounded signature, never a full large PDF.
  raw=r.read(4096 if path.endswith(('.pdf','.png','.webp')) else 500001)
  if len(raw)>500000:raise ValueError('Smoke response too large')
  return r.status,raw,r.headers.get_content_type(),{k.lower():v for k,v in r.headers.items()}
def smoke(target,fetch=None,expected_sha=None):
 fetch=fetch or (lambda p:probe(target,p))
 try:
  status,raw,mime,headers=fetch('/');text=raw.decode() if isinstance(raw,bytes) else raw
  if status!=200 or mime!='text/html' or not re.search(r'<link[^>]*rel=["\x27]canonical["\x27][^>]*href=["\x27]'+re.escape(target.origin+'/')+r'["\x27]',text):return False
  if headers.get('x-content-type-options')!='nosniff' or not headers.get('content-security-policy'):return False
  status,raw,_,_=fetch('/robots.txt');text=raw.decode() if isinstance(raw,bytes) else raw
  if status!=200 or target.origin+target.sitemap not in text or re.search(r'^Disallow:\s*/\s*$',text,re.M):return False
  status,location,_,_=fetch('@www')
  if status!=301 or location!=target.origin+'/':return False
  if fetch(target.sitemap)[0]!=200 or fetch('/__release_missing_probe__')[0]!=404:return False
  if expected_sha is not None:
   import json
   st,raw,_,h=fetch('/__release.json?health='+expected_sha)
   if st!=200 or h.get('cache-control')!='no-store' or json.loads(raw)!={'schema':1,'project':target.project,'sha':expected_sha}:return False
  if target.project=='usmapgames':
   st,_,_,h=fetch('/learn')
   if st!=301 or h.get('location') not in ('/learn/',target.origin+'/learn/'):return False
   if fetch('/us-states-quiz/')[0]!=200:return False
   pdf='/printables/blank-us-map-a4.pdf'
  else:pdf='/media/pdfs/animales-para-colorear/buho-en-una-rama-a4.pdf'
  status,body,mime,_=fetch(pdf)
  return status==200 and mime=='application/pdf' and (body if isinstance(body,bytes) else body.encode()).startswith(b'%PDF-')
 except Exception:return False
