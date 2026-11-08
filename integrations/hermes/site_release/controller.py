import re
from .approval import verify_confirmation
from .manifest import prepare_manifest,check_baseline
from .server import approval_claims
from .tickets import sign_ticket

class Controller:
 def __init__(self,config,store,gh,cf,feishu,private_key):self.config=config;self.store=store;self.gh=gh;self.cf=cf;self.feishu=feishu;self.private_key=private_key
 def _prepare(self,m):
  warning='线上 SHA 未知：无法保证完整差异，确认代表批准整个目标版本。' if m.get('baseline_unmapped') else ''
  verb='确认回滚' if m['operation']=='rollback' else '确认发布'
  text=f"{self.config.project} 生产{'回滚' if m['operation']=='rollback' else '发布'}待确认\n目标 SHA: {m['target_sha']}\n当前 version: {m['expected_previous_version']}\n目标 version: {m.get('target_version') or '构建后生成'}\n{warning}\n有效期10分钟。仅授权用户在本群发送：\n{verb} {m['release_id']} {m['nonce']}"
  if m.get('changes') is not None:
   text+='\n完整提交差异：'
   for change in m['changes']:
    text+='\n'+change['sha']+' '+change['title'][:160]+' PR '+','.join('#'+str(n) for n in change['prs'])
  if len(text.encode('utf-8'))>24000:raise ValueError('Change list too large; manual release review required')
  self.store.prepare(m)
  try:mid=self.feishu.send_text(self.config.chat_id,text,m['release_id']);self.store.note(m['release_id'],{'notice_message_id':mid})
  except Exception:self.store.note(m['release_id'],{'notice_error':True})
  return self.store.get(m['release_id'])
 def prepare(self,now):
  m=prepare_manifest(self.config,self.gh,self.cf,now)
  try:m['source_sha']=self.store.healthy_version(m['expected_previous_version'])['manifest']['target_sha']
  except ValueError:pass
  m['baseline_unmapped']=m['source_sha'] is None
  m['changes']=self.gh.changes(m['source_sha'],m['target_sha']) if m['source_sha'] else None
  return self._prepare(m)
 def prepare_rollback(self,version_id,now):
  if not re.fullmatch('[0-9a-f-]{36}',version_id):raise ValueError('Invalid version')
  target=self.store.healthy_version(version_id);m=prepare_manifest(self.config,self.gh,self.cf,now)
  if version_id==m['expected_previous_version']:raise ValueError('Already serving requested version')
  m.update(operation='rollback',workflow_sha=m['target_sha'],target_sha=target['manifest']['target_sha'],target_version=version_id,baseline_unmapped=False)
  return self._prepare(m)
 def locate(self,rid):
  m=self.store.get(rid)['manifest'];verb='确认回滚' if m['operation']=='rollback' else '确认发布'
  candidates=self.feishu.find_confirmation(self.config.chat_id,f"{verb} {rid} {m['nonce']}",m['prepared_at']*1000)
  if len(candidates)!=1:raise ValueError('Confirmation not uniquely located')
  return {'message_id':candidates[0]}
 def confirm(self,rid,mid,now):
  if not self.config.production_enabled:raise ValueError('Production disabled')
  row=self.store.get(rid)
  if row['state']!='PREPARED' or not row['evidence'].get('notice_message_id'):raise ValueError('Not awaiting delivered confirmation')
  v=verify_confirmation(self.feishu.get_message(mid),row['manifest'],self.config,now*1000+999)
  check_baseline(row['manifest'],self.gh,self.cf)
  ticket=sign_ticket(approval_claims({**row,'actor':v['actor_id'],'approved_at':now}),self.private_key)
  row=self.store.approve_for_dispatch(rid,v['message_id'],v['actor_id'],now)
  # The approval and dispatch intent are one atomic durable transaction.
  try:
   response=self.gh.dispatch(rid,row['manifest']['target_sha'],ticket);run=response.get('workflow_run_id')
   if not run:raise ValueError('No run identity')
   self.store.transition(rid,'DISPATCH_UNCERTAIN','DISPATCHED',{'run_id':str(run)})
  except Exception:pass
  from .notices import publish_status
  publish_status(self,rid,now)
  return self.store.get(rid)
