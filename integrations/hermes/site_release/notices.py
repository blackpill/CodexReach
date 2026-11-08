"""Bounded persistent notification outbox, independent from deployment attempts."""
import hashlib,time
MEANINGFUL={'DISPATCHED','DISPATCH_UNCERTAIN','DEPLOYING','DEPLOYED','VALIDATION_FAILED','DEPLOY_UNCERTAIN','HEALTHY','DEPLOYED_UNHEALTHY'}
def publish_status(controller,rid,now=None,attention=False):
 now=int(time.time()) if now is None else now;s=controller.store;r=s.get(rid)
 if r['state'] in MEANINGFUL:s.queue_notice(rid,r['state'],now)
 if attention:s.queue_notice(rid,'RECONCILE_ATTENTION',now)
 pending=list(s.db.execute('SELECT state FROM notices WHERE release_id=? AND status IN ("PENDING","IN_FLIGHT")',(rid,)))
 for row in pending:
  state=row['state']
  if not s.reserve_notice(rid,state,now):continue
  uuid='notice_'+hashlib.sha256((controller.config.project+':'+rid+':'+state).encode()).hexdigest()[:32]
  text=f"{controller.config.project} {rid}: {state}\n目标 SHA: {r['manifest']['target_sha']}\n"
  if state in ('DEPLOY_UNCERTAIN','DISPATCH_UNCERTAIN','RECONCILE_ATTENTION'):text+='结果需人工对账；不会自动重新部署。'
  sent=False
  try:controller.feishu.send_text(controller.config.chat_id,text,uuid);sent=True
  except Exception:pass
  s.finish_notice(rid,state,sent)
 statuses=[dict(x) for x in s.db.execute('SELECT state,status,attempts FROM notices WHERE release_id=?',(rid,))]
 s.note(rid,{'notifications':statuses})
