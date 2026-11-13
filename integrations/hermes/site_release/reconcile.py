"""Read-only external reconciliation. This module cannot dispatch or deploy."""
import re
import time

from .manifest import digest,verify_artifact_manifest,rollback_artifact_manifest

def _reconcile(controller,rid,*,recover_confirmed=False):
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
  fields={'schema','project','repository_id','operation','release_id','run_id','sha','artifact_digest','previous_version','version_id','deployment_id','deploy_status','health_status'}
  if set(d)!=fields or type(d.get('schema')) is not int or type(d.get('repository_id')) is not int:raise ValueError('Invalid result schema')
  expected_manifest=verify_artifact_manifest(controller.gh.package_manifest(r['run_id']),controller.config.target,m['target_sha']) if m['operation']=='deploy' else rollback_artifact_manifest(controller.config.target,m['target_sha'],m['target_version'])
  if d.get('artifact_digest')!=digest(expected_manifest) or (m['operation']=='rollback' and d.get('version_id')!=m['target_version']):raise ValueError('Result does not match approved artifact/version')
  if d.get('schema')!=1 or d.get('project')!=m['project'] or d.get('repository_id')!=m['repository_id'] or d.get('release_id')!=rid or str(d.get('run_id'))!=r['run_id'] or d.get('sha')!=m['target_sha'] or d.get('operation')!=m['operation'] or d.get('previous_version')!=m['expected_previous_version']:raise ValueError()
 except Exception:
  if r['state']=='DISPATCHED':return s.transition(rid,'DISPATCHED','VALIDATION_FAILED',{'result_error':True})
  if r['state']=='DEPLOYING':return s.transition(rid,'DEPLOYING','DEPLOY_UNCERTAIN',{'result_error':True})
  return r
 # Only an explicit request via the existing privileged local socket may
 # close a failed USMapGames run; the poller cannot grant this exception.
 if (recover_confirmed and m['project']=='usmapgames' and m['operation']=='deploy'
     and r['state']=='DEPLOY_UNCERTAIN' and r['claimed']
     and run.get('conclusion')=='failure' and d.get('deploy_status')=='deployed'
     and d.get('health_status')=='unhealthy'):
  ids={key:d.get(key) for key in ('version_id','deployment_id')}
  if not all(isinstance(value,str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',value)
             for value in ids.values()):raise ValueError('Invalid deployed version evidence')
  def check_live():
   live=controller.cf.snapshot()
   if any(live.get(key)!=value for key,value in ids.items()):
    raise ValueError('Live version differs from result')
  check_live()
  if not controller.cf.health(m['target_sha']):return r
  check_live()
  return s.transition(rid,'DEPLOY_UNCERTAIN','RECONCILED_HEALTHY',{
   **d,'workflow_conclusion':'failure','reconcile_health_status':'healthy',
   'reconciled_at':int(time.time()),
  })
 if run.get('conclusion')!='success' or d.get('deploy_status')!='deployed':
  if r['state']=='DEPLOYING':return s.transition(rid,'DEPLOYING','DEPLOY_UNCERTAIN',d)
  return r
 if not r['claimed']:raise ValueError('Deployment without claim')
 live=controller.cf.snapshot()
 if live['version_id']!=d.get('version_id') or live['deployment_id']!=d.get('deployment_id'):raise ValueError('Live version differs from result')
 if r['state']!='DEPLOYED':r=s.transition(rid,r['state'],'DEPLOYED',d)
 healthy=d.get('health_status')=='healthy' and controller.cf.health(m['target_sha'])
 r=s.transition(rid,'DEPLOYED','HEALTHY' if healthy else 'DEPLOYED_UNHEALTHY',d)
 return s.get(rid)

def reconcile(controller,rid,now=None,*,recover_confirmed=False):
 from .notices import publish_status
 attention=False
 try:result=_reconcile(controller,rid,recover_confirmed=recover_confirmed)
 except Exception:
  controller.store.note(rid,{'reconcile_error':True});attention=True
 publish_status(controller,rid,now,attention=attention)
 return controller.store.get(rid)
