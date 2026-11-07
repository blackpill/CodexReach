"""Read-only external reconciliation. This module cannot dispatch or deploy."""
from .manifest import digest

def _reconcile(controller,rid):
 s=controller.store;r=s.get(rid);m=r['manifest']
 if r['state']=='DISPATCH_UNCERTAIN':
  run=controller.gh.locate_run(rid)
  expected=m.get('workflow_sha',m['target_sha'])
  if run.get('head_sha')!=expected or run.get('event')!='workflow_dispatch' or run.get('path')!='.github/workflows/deploy-production.yml':raise ValueError('Run identity mismatch')
  r=s.transition(rid,'DISPATCH_UNCERTAIN','DISPATCHED',{'run_id':str(run['id'])})
 if r['state'] not in ('DISPATCHED','DEPLOYING','DEPLOY_UNCERTAIN','DEPLOYED'):return r
 run=controller.gh.run(r['run_id'])
 if str(run.get('id'))!=r['run_id'] or run.get('head_sha')!=m.get('workflow_sha',m['target_sha']) or run.get('event')!='workflow_dispatch' or run.get('path')!='.github/workflows/deploy-production.yml' or int(run.get('run_attempt',0))!=1:raise ValueError('Run evidence mismatch')
 if run.get('status')!='completed':return r
 try:
  d=controller.gh.result(r['run_id'])
  if d.get('release_id')!=rid or str(d.get('run_id'))!=r['run_id'] or d.get('sha')!=m['target_sha'] or d.get('operation')!=m['operation'] or d.get('previous_version')!=m['expected_previous_version']:raise ValueError()
 except Exception:
  if r['state']=='DISPATCHED':return s.transition(rid,'DISPATCHED','VALIDATION_FAILED',{'result_error':True})
  if r['state']=='DEPLOYING':return s.transition(rid,'DEPLOYING','DEPLOY_UNCERTAIN',{'result_error':True})
  return r
 if d.get('deploy_status')!='deployed':
  if r['state']=='DEPLOYING':return s.transition(rid,'DEPLOYING','DEPLOY_UNCERTAIN',d)
  return r
 if not r['claimed']:raise ValueError('Deployment without claim')
 live=controller.cf.snapshot()
 if live['version_id']!=d.get('version_id') or live['deployment_id']!=d.get('deployment_id'):raise ValueError('Live version differs from result')
 if r['state']!='DEPLOYED':r=s.transition(rid,r['state'],'DEPLOYED',d)
 healthy=d.get('health_status')=='healthy' and controller.cf.health(m['target_sha'])
 r=s.transition(rid,'DEPLOYED','HEALTHY' if healthy else 'DEPLOYED_UNHEALTHY',d)
 return s.get(rid)

def reconcile(controller,rid,now=None):
 from .notices import publish_status
 attention=False
 try:result=_reconcile(controller,rid)
 except Exception:
  controller.store.note(rid,{'reconcile_error':True});attention=True
 publish_status(controller,rid,now,attention=attention)
 return controller.store.get(rid)
