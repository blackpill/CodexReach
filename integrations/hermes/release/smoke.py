import urllib.request,urllib.error,re
from .transport import NoRedirect

def probe(path):
 req=urllib.request.Request('https://classgames.net'+path,headers={'Cache-Control':'no-cache','User-Agent':'ClassGamesReleaseHealth/1.0'})
 try:r=urllib.request.build_opener(NoRedirect).open(req,timeout=15)
 except urllib.error.HTTPError as e:r=e
 with r:
  body=r.read(500001)
  if len(body)>500000:raise ValueError('Smoke response too large')
  return r.status,body.decode('utf-8',errors='replace'),r.headers.get_content_type()

def smoke(fetch=probe):
 try:
  status,text,mime=fetch('/')
  if status!=200 or mime!='text/html' or not re.search(r'<link[^>]*rel=["\x27]canonical["\x27][^>]*href=["\x27]https://classgames.net/["\x27]',text):return False
  status,text,mime=fetch('/robots.txt')
  if status!=200 or 'https://classgames.net/sitemap-index.xml' not in text or re.search(r'^Disallow:\s*/\s*$',text,re.M):return False
  status,text,mime=fetch('/sitemap-index.xml')
  if status!=200 or '<sitemapindex' not in text or 'https://classgames.net/' not in text:return False
  return fetch('/__release_missing_probe__')[0]==404
 except Exception:return False
