import urllib.request,urllib.error,re
from .transport import NoRedirect

def probe(target,path):
 if not path.startswith('/') or path.startswith('//'):raise ValueError('Same-origin path required')
 req=urllib.request.Request(target.origin+path,headers={'Cache-Control':'no-cache','User-Agent':'SiteReleaseHealth/1.0'})
 try:r=urllib.request.build_opener(NoRedirect).open(req,timeout=15)
 except urllib.error.HTTPError as e:r=e
 with r:
  # Binary media samples need only a bounded signature, never a full large PDF.
  raw=r.read(4096 if path.endswith(('.pdf','.png','.webp')) else 500001)
  if len(raw)>500000:raise ValueError('Smoke response too large')
  return r.status,raw,r.headers.get_content_type()
def smoke(target,fetch=None):
 fetch=fetch or (lambda p:probe(target,p))
 try:
  status,raw,mime=fetch('/');text=raw.decode() if isinstance(raw,bytes) else raw
  if status!=200 or mime!='text/html' or target.origin+'/' not in text or not re.search(r'rel=["\x27]canonical["\x27]',text):return False
  status,raw,_=fetch('/robots.txt');text=raw.decode() if isinstance(raw,bytes) else raw
  if status!=200 or target.origin+target.sitemap not in text or re.search(r'^Disallow:\s*/\s*$',text,re.M):return False
  if fetch(target.sitemap)[0]!=200 or fetch('/__release_missing_probe__')[0]!=404:return False
  if target.project=='usmapgames':
   if fetch('/us-states-quiz/')[0]!=200:return False
   pdf='/printables/blank-us-map-a4.pdf'
  else:pdf='/media/pdfs/animales-para-colorear/buho-en-una-rama-a4.pdf'
  status,body,mime=fetch(pdf)
  return status==200 and mime=='application/pdf' and (body if isinstance(body,bytes) else body.encode()).startswith(b'%PDF-')
 except Exception:return False
