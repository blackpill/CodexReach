"""Exact per-site receipt schema; a different key or project never authorizes this target."""
import re,jwt
from .config import get_target
FIELDS={'schema','project','repository','repository_id','worker','release_id','operation','target_sha','target_version','environment','expected_previous_version','config_digest','approved_by','approved_at','expires_at'}
def validate(a,now=None,target=None):
 if not isinstance(a,dict) or set(a)!=FIELDS:raise ValueError('Invalid ticket fields')
 t=get_target(a['project'])
 if target is not None and t!=target:raise ValueError('Ticket target mismatch')
 if any(a.get(k)!=v for k,v in {'schema':1,'repository':t.repository,'repository_id':t.repository_id,'worker':t.worker,'environment':'production'}.items()) or type(a['schema']) is not int or type(a['repository_id']) is not int:raise ValueError('Invalid ticket scope')
 for k,pattern in [('target_sha','[0-9a-f]{40}'),('config_digest','[0-9a-f]{64}'),('release_id','[A-Za-z0-9_-]{1,80}'),('approved_by','ou_[A-Za-z0-9_-]{1,80}'),('expected_previous_version','[0-9a-f-]{36}')]:
  if not isinstance(a[k],str) or not re.fullmatch(pattern,a[k]):raise ValueError('Invalid ticket identity')
 if a['operation'] not in ('deploy','rollback') or (a['operation']=='deploy' and a['target_version'] is not None) or (a['operation']=='rollback' and (not isinstance(a['target_version'],str) or not re.fullmatch('[0-9a-f-]{36}',a['target_version']))):raise ValueError('Operation/version mismatch')
 if type(a['approved_at']) is not int or type(a['expires_at']) is not int or a['expires_at']!=a['approved_at']+5400:raise ValueError('Invalid ticket lifetime')
 if now is not None and not a['approved_at']<=now<a['expires_at']:raise ValueError('Expired ticket')
 return a

def sign_ticket(approval,private_key):
 validate(approval);return jwt.encode(approval,private_key,algorithm='EdDSA',headers={'typ':'release+jwt'})
def verify_ticket(ticket,public_key,now,target):
 try:
  if not isinstance(ticket,str) or len(ticket)>12000 or jwt.get_unverified_header(ticket).get('typ')!='release+jwt':raise ValueError()
  return validate(jwt.decode(ticket,public_key,algorithms=['EdDSA']),now,target)
 except (jwt.PyJWTError,ValueError,KeyError,TypeError,AttributeError):raise ValueError('Invalid release ticket') from None
