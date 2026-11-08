import unittest
from .test_core import A,B
from .smoke import smoke
class SmokeTests(unittest.TestCase):
 def fetch(self,t,wrong=False):
  def read(p):
   if p=='/':return 200,('<link rel="canonical" href="'+('https://evil.com/' if wrong else t.origin+'/')+'"> '+t.origin+'/'),'text/html'
   if p=='@www':return 301,t.origin+'/','redirect'
   if p=='/robots.txt':return 200,'Sitemap: '+t.origin+t.sitemap,'text/plain'
   if p==t.sitemap:return 200,'<urlset/>','application/xml'
   if p=='/__release_missing_probe__':return 404,'missing','text/html'
   if p.endswith('.pdf'):return 200,b'%PDF-local','application/pdf'
   return 200,'ok','text/html'
  return read
 def test_site_specific_sitemap_pdf_and_www(self):
  for t in [A,B]:self.assertTrue(smoke(t,self.fetch(t)))
 def test_wrong_canonical_not_rescued_by_other_same_origin_link(self):
  self.assertFalse(smoke(A,self.fetch(A,True)))
