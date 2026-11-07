"""EdDSA JWT receipts signed only after authoritative approval."""
import re,jwt
FIELDS={'release_id','operation','repository_id','target_sha','target_version','environment','expected_previous_version','config_digest','approved_by','approved_at','expires_at'}
def validate(a,now=None):
 if set(a)!=FIELDS or a['repository_id']!=1223017142 or a['environment']!='production' or a['operation'] not in ('deploy','rollback'):raise ValueError('Invalid ticket scope')
 if not re.fullmatch('[0-9a-f]{40}',a['target_sha']) or not re.fullmatch('[0-9a-f]{64}',a['config_digest']):raise ValueError('Invalid target')
 if (a['operation']=='deploy' and a['target_version'] is not None) or (a['operation']=='rollback' and not a['target_version']):raise ValueError('Operation/version mismatch')
 if type(a['approved_at']) is not int or type(a['expires_at']) is not int or a['expires_at']!=a['approved_at']+5400:raise ValueError('Invalid ticket lifetime')
 if now is not None and not a['approved_at']<=now<a['expires_at']:raise ValueError('Expired ticket')
 if not a['approved_by'].startswith('ou_') or not a['expected_previous_version']:raise ValueError('Missing approval')
 return a

def sign_ticket(approval,private_key):
 validate(approval);return jwt.encode(approval,private_key,algorithm='EdDSA',headers={'typ':'release+jwt'})
def verify_ticket(ticket,public_key,now):
 try:
  if not isinstance(ticket,str) or len(ticket)>12000:raise ValueError()
  if jwt.get_unverified_header(ticket).get('typ')!='release+jwt':raise ValueError()
  return validate(jwt.decode(ticket,public_key,algorithms=['EdDSA']),now)
 except (jwt.PyJWTError,ValueError,KeyError,TypeError,AttributeError):raise ValueError('Invalid release ticket') from None
