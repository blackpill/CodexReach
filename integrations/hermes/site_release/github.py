import re
from .transport import request
class GithubClient:
 def __init__(self,target,token,transport=request):self.target=target;self.token=token;self.transport=transport
 def _api(self,path,method='GET',data=None):return self.transport(method,'https://api.github.com/repos/'+self.target.repository+'/'+path,data,{'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'})
 def repository(self):return self.transport('GET','https://api.github.com/repos/'+self.target.repository,None,{'Authorization':'Bearer '+self.token})
 def main_head(self):return self._api('git/ref/heads/main')['object']['sha']
 def checks(self,sha):
  if not re.fullmatch('[0-9a-f]{40}',sha):raise ValueError('Invalid SHA')
  d=self._api('commits/'+sha+'/check-runs?per_page=100')
  if d.get('total_count',0)>100:raise ValueError('Check pagination exceeds limit')
  return d.get('check_runs',[])
 def verified_workflow(self,sha):
  for workflow in (self.target.ci_workflow,'release-contracts.yml'):
   d=self._api('actions/workflows/'+workflow+'/runs?head_sha='+sha+'&event=push&per_page=10')
   if not any(r.get('head_sha')==sha and r.get('head_branch')=='main' and r.get('event')=='push' and r.get('status')=='completed' and r.get('conclusion')=='success' and r.get('path')=='.github/workflows/'+workflow for r in d.get('workflow_runs',[])):return False
  return True

 def dispatch(self,rid,sha,ticket):
  return self._api('actions/workflows/deploy-production.yml/dispatches','POST',{'ref':'main','inputs':{'release_id':rid,'target_sha':sha,'approval_ticket':ticket}})
 def run(self,run_id):
  if not str(run_id).isdigit():raise ValueError('Invalid run ID')
  return self._api('actions/runs/'+str(run_id))
 def locate_run(self,release_id):
  d=self._api('actions/workflows/deploy-production.yml/runs?event=workflow_dispatch&per_page=100')
  matches=[r for r in d.get('workflow_runs',[]) if r.get('display_title')==self.target.project+'-release-'+release_id]
  if len(matches)!=1:raise ValueError('Dispatch not uniquely reconciled')
  return matches[0]
 def result(self,run_id):
  import io,json,zipfile,urllib.request,urllib.error,urllib.parse
  from .transport import NoRedirect
  data=self._api(f'actions/runs/{int(run_id)}/artifacts?per_page=100')
  items=[x for x in data.get('artifacts',[]) if x.get('name')==self.target.project+'-release-result' and not x.get('expired')]
  if len(items)!=1 or items[0].get('size_in_bytes',0)>200000:raise ValueError('Missing or oversized result artifact')
  aid=items[0]['id'];url=f'https://api.github.com/repos/{self.target.repository}/actions/artifacts/{int(aid)}/zip'
  req=urllib.request.Request(url,headers={'Authorization':'Bearer '+self.token})
  try:
   urllib.request.build_opener(NoRedirect).open(req,timeout=20)
   raise ValueError('Expected artifact redirect')
  except urllib.error.HTTPError as e:
   if e.code!=302:raise ValueError('Artifact unavailable') from None
   location=e.headers.get('Location','')
  u=urllib.parse.urlparse(location)
  if u.scheme!='https' or not u.hostname or not u.hostname.endswith('.blob.core.windows.net') or u.username:raise ValueError('Unexpected artifact storage')
  with urllib.request.build_opener(NoRedirect).open(location,timeout=20) as r:raw=r.read(200001)
  if len(raw)>200000:raise ValueError('Artifact too large')
  with zipfile.ZipFile(io.BytesIO(raw)) as z:
   if z.namelist()!=['release-result.json'] or z.getinfo('release-result.json').file_size>32000:raise ValueError('Unexpected artifact payload')
   return json.loads(z.read('release-result.json'))
 def changes(self,source_sha,target_sha):
  if not all(re.fullmatch('[0-9a-f]{40}',s) for s in [source_sha,target_sha]):raise ValueError('Invalid comparison SHA')
  d=self._api('compare/'+source_sha+'...'+target_sha+'?per_page=100&page=1')
  commits=d.get('commits',[])
  if d.get('status') not in ('ahead','identical') or d.get('total_commits')!=len(commits) or len(commits)>=100:raise ValueError('Cannot prove bounded complete commit difference')
  out=[]
  for c in commits:
   sha=c.get('sha','')
   if not re.fullmatch('[0-9a-f]{40}',sha):raise ValueError('Invalid comparison result')
   prs=self._api('commits/'+sha+'/pulls?per_page=100')
   if not isinstance(prs,list) or len(prs)>=100:raise ValueError('Incomplete PR associations')
   out.append({'sha':sha,'title':c['commit']['message'].splitlines()[0],'prs':sorted({p['number'] for p in prs if p.get('base',{}).get('repo',{}).get('id')==self.target.repository_id})})
  return out

 def package_manifest(self,run_id):
  import io,json,zipfile,urllib.request,urllib.error,urllib.parse
  from .transport import NoRedirect
  d=self._api(f'actions/runs/{int(run_id)}/artifacts?per_page=100')
  if d.get('total_count',len(d.get('artifacts',[])))>100:raise ValueError('Incomplete artifacts')
  items=[a for a in d.get('artifacts',[]) if a.get('name')==self.target.project+'-release-manifest' and not a.get('expired')]
  if len(items)!=1 or items[0].get('size_in_bytes',0)>2000000:raise ValueError('Manifest artifact unavailable')
  url=f'https://api.github.com/repos/{self.target.repository}/actions/artifacts/{int(items[0]["id"])}/zip'
  req=urllib.request.Request(url,headers={'Authorization':'Bearer '+self.token,'User-Agent':'SiteReleaseControl/1.0'})
  try:
   with urllib.request.build_opener(NoRedirect).open(req,timeout=20):pass
   raise ValueError('Expected artifact redirect')
  except urllib.error.HTTPError as e:
   if e.code!=302:e.close();raise ValueError('Manifest artifact unavailable') from None
   location=e.headers.get('Location','');e.close()
  u=urllib.parse.urlparse(location)
  if u.scheme!='https' or not u.hostname or not u.hostname.endswith('.blob.core.windows.net') or u.username:raise ValueError('Unexpected artifact storage')
  with urllib.request.build_opener(NoRedirect).open(location,timeout=20) as r:raw=r.read(2000001)
  if len(raw)>2000000:raise ValueError('Manifest archive too large')
  with zipfile.ZipFile(io.BytesIO(raw)) as z:
   if z.namelist()!=['manifest.json'] or z.getinfo('manifest.json').file_size>4000000:raise ValueError('Unexpected manifest payload')
   return json.loads(z.read('manifest.json'))
