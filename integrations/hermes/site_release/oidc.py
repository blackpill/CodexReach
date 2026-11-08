import jwt
ISSUER='https://token.actions.githubusercontent.com'
_jwks=jwt.PyJWKClient(ISSUER+'/.well-known/jwks',timeout=10)
def verify_github_oidc(token,expected,now,target,key_resolver=None):
 try:
  if set(expected)-{'workflow_sha','sha','run_id'}:raise ValueError()
  if not isinstance(token,str) or len(token)>16000:raise ValueError()
  if jwt.get_unverified_header(token).get('alg')!='RS256':raise ValueError()
  key=key_resolver(token) if key_resolver else _jwks.get_signing_key_from_jwt(token).key
  c=jwt.decode(token,key,algorithms=['RS256'],issuer=ISSUER,audience=target.audience,options={'require':['exp','iat','nbf','iss','aud','repository_id','workflow_ref','workflow_sha','sha','ref','event_name','run_id','run_attempt','runner_environment']})
  fixed={'repository_id':str(target.repository_id),'workflow_ref':target.repository+'/.github/workflows/'+target.workflow+'@refs/heads/main','ref':'refs/heads/main','event_name':'workflow_dispatch','run_attempt':'1','runner_environment':'github-hosted',**expected}
  if any(c.get(k)!=v for k,v in fixed.items()) or not str(c['run_id']).isdigit():raise ValueError()
  if any(type(c[k]) is not int for k in ['iat','nbf','exp']) or not c['nbf']<=now<c['exp'] or c['iat']>now or c['exp']>c['iat']+600:raise ValueError()
  return c
 except (jwt.PyJWTError,ValueError,TypeError,KeyError,OSError):raise ValueError('GitHub OIDC rejected') from None
