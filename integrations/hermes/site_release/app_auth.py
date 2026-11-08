import re,jwt
from .transport import request

def installation_token(target,app_id,installation_id,private_key,now,transport=request):
 if not re.fullmatch('[0-9]+',app_id) or not re.fullmatch('[0-9]+',installation_id):raise ValueError('Invalid GitHub App identity')
 bearer=jwt.encode({'iss':app_id,'iat':now-30,'exp':now+540},private_key,algorithm='RS256')
 d=transport('POST',f'https://api.github.com/app/installations/{installation_id}/access_tokens',{'repository_ids':[target.repository_id],'permissions':{'contents':'read','checks':'read','pull_requests':'read','actions':'write'}},{'Authorization':'Bearer '+bearer,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'})
 if not isinstance(d.get('token'),str):raise ValueError('GitHub App authentication unavailable')
 return d['token']
