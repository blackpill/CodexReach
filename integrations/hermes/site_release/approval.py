"""Authoritative Feishu message validation; model-provided identity is never used."""
import json,re

def verify_confirmation(message,manifest,config,now_ms):
 try:
  if manifest.get('project')!=config.project or manifest.get('repository_id')!=config.repository_id:raise ValueError()
  required={'message_id','chat_id','create_time','update_time','updated','deleted','msg_type','sender','body'}
  if not required<=message.keys():raise ValueError()
  sender=message['sender'];created=int(message['create_time'])
  if not re.fullmatch(r'om_[A-Za-z0-9_-]+',message['message_id']):raise ValueError()
  if message['updated'] is not False or message['deleted'] is not False or str(message['update_time'])!=str(message['create_time']):raise ValueError()
  if message['chat_id']!=config.chat_id or message['msg_type']!='text':raise ValueError()
  if sender.get('sender_type')!='user' or sender.get('id_type')!='open_id' or sender.get('id') not in config.allowed_users or not config.tenant_key or sender.get('tenant_key')!=config.tenant_key:raise ValueError()
  if not manifest['prepared_at']*1000<=created<=now_ms<manifest['expires_at']*1000:raise ValueError()
  if manifest.get('thread_id') and message.get('thread_id')!=manifest['thread_id']:raise ValueError()
  verb="确认回滚" if manifest.get("operation")=="rollback" else "确认发布"
  expected=f"{verb} {manifest['release_id']} {manifest['nonce']}"
  content=json.loads(message['body']['content'])
  if content!={'text':expected}:raise ValueError()
  return {'actor_id':sender['id'],'message_id':message['message_id']}
 except (KeyError,TypeError,ValueError):raise ValueError('Confirmation rejected') from None
