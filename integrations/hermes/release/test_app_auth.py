import unittest,jwt
from cryptography.hazmat.primitives.asymmetric.rsa import generate_private_key
from cryptography.hazmat.primitives import serialization
from integrations.hermes.release.app_auth import installation_token
class AppAuthTests(unittest.TestCase):
 def test_tokens_are_scoped_and_private_key_never_sent(self):
  k=generate_private_key(public_exponent=65537,key_size=2048);pem=k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption());seen=[]
  def api(method,url,data,headers):
   seen.append(data);c=jwt.decode(headers['Authorization'][7:],k.public_key(),algorithms=['RS256'],options={'verify_exp':False,'verify_iat':False});self.assertEqual(c['iss'],'123');self.assertEqual(c['exp'],640);return {'token':'installation-token'}
  self.assertEqual(installation_token('123','456',pem,100,api),'installation-token');self.assertEqual(seen[0]['repository_ids'],[1223017142]);self.assertNotIn('administration',seen[0]['permissions'])
