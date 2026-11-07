import unittest
from integrations.hermes.release.smoke import smoke
class SmokeTests(unittest.TestCase):
 def test_no_redirects_or_stale_content_can_pass(self):
  good={'/':(200,'<html><link rel="canonical" href="https://classgames.net/"></html>','text/html'),'/robots.txt':(200,'User-agent: *\nAllow: /\nSitemap: https://classgames.net/sitemap-index.xml','text/plain'),'/sitemap-index.xml':(200,'<sitemapindex>https://classgames.net/sitemap-0.xml</sitemapindex>','application/xml'),'/__release_missing_probe__':(404,'not found','text/html')}
  self.assertTrue(smoke(lambda path:good[path]))
  for path,wrong in [('/',(301,'','text/html')),('/robots.txt',(200,'Disallow: /','text/plain')),('/__release_missing_probe__',(200,'ok','text/html'))]:
   bad={**good,path:wrong};self.assertFalse(smoke(lambda p:bad[p]))
