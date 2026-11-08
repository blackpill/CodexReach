import unittest
from .test_core import A,B
from .smoke import smoke
class SmokeTests(unittest.TestCase):
 def fetch(self,t,wrong=False):
  def read(p):
   if p=='/':return 200,('<link rel="canonical" href="'+('https://evil.com/' if wrong else t.origin+'/')+'"> '+t.origin+'/'),'text/html',{'x-content-type-options':'nosniff','content-security-policy':"default-src 'self'"}
   if p=='@www':return 301,t.origin+'/','redirect',{}
   if p=='/robots.txt':return 200,'Sitemap: '+t.origin+t.sitemap,'text/plain',{}
   if p==t.sitemap:return 200,'<urlset/>','application/xml',{}
   if p=='/__release_missing_probe__':return 404,'missing','text/html',{'x-content-type-options':'nosniff','content-security-policy':"default-src 'self'"}
   if p=='/learn':return 301,'','text/plain',{'location':'/learn/'}
   if p.startswith('/__release.json?'):return 200,'{"schema":1,"project":"'+t.project+'","sha":"'+'a'*40+'"}','application/json',{'cache-control':'no-store'}
   if p.endswith('.pdf'):return 200,b'%PDF-local','application/pdf',{}
   return 200,'ok','text/html',{'x-content-type-options':'nosniff','content-security-policy':"default-src 'self'"}
  return read
 def test_site_specific_sitemap_pdf_and_www(self):
  for t in [A,B]:self.assertTrue(smoke(t,self.fetch(t),expected_sha="a"*40))
 def test_wrong_canonical_not_rescued_by_other_same_origin_link(self):
  self.assertFalse(smoke(A,self.fetch(A,True)))

 def test_missing_security_and_cache_headers_rejected(self):
  for path,header in [('/', 'x-content-type-options'),('/', 'content-security-policy'),('/__release.json?health='+'a'*40,'cache-control')]:
   original=self.fetch(A)
   def read(p):
    status,body,mime,headers=original(p)
    if p==path:headers={k:v for k,v in headers.items() if k!=header}
    return status,body,mime,headers
   self.assertFalse(smoke(A,read,expected_sha='a'*40))
 def test_specific_training_bot_block_does_not_block_public_search(self):
  original=self.fetch(A)
  def read(p):
   if p=='/robots.txt':return 200,'User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /\nSitemap: '+A.origin+A.sitemap,'text/plain',{}
   return original(p)
  self.assertTrue(smoke(A,read,expected_sha='a'*40))
