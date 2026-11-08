import re,urllib.parse
from .transport import request
class FeishuClient:
 def __init__(self,app_id,app_secret,transport=request):self.app_id=app_id;self.app_secret=app_secret;self.transport=transport;self.token=None
 def _api(self,path,query=None):
  if self.token is None:
   d=self.transport('POST','https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{'app_id':self.app_id,'app_secret':self.app_secret},{})
   if d.get('code')!=0 or not d.get('tenant_access_token'):raise ValueError('Feishu authentication unavailable')
   self.token=d['tenant_access_token']
  url='https://open.feishu.cn/open-apis/'+path
  if query:url+='?'+urllib.parse.urlencode(query)
  d=self.transport('GET',url,None,{'Authorization':'Bearer '+self.token})
  if d.get('code')!=0:raise ValueError('Feishu read unavailable')
  return d['data']
 def get_message(self,message_id):
  if not re.fullmatch(r'om_[A-Za-z0-9_-]+',message_id):raise ValueError('Invalid message ID')
  items=self._api('im/v1/messages/'+message_id).get('items',[])
  if len(items)!=1 or items[0].get('message_id')!=message_id:raise ValueError('Ambiguous message')
  return items[0]
 def find_confirmation(self,chat_id,exact_text,since_ms):
  import json
  matches=[];page=None
  for _ in range(10):
   q={'container_id_type':'chat','container_id':chat_id,'page_size':50,'start_time':since_ms//1000,'sort_type':'ByCreateTimeDesc'}
   if page:q['page_token']=page
   d=self._api('im/v1/messages',q)
   for m in d.get('items',[]):
    try:content=json.loads(m.get('body',{}).get('content','{}'))
    except (ValueError,TypeError):continue
    if content=={'text':exact_text}:matches.append(m['message_id'])
   if not d.get('has_more'):return matches
   new=d.get('page_token')
   if not new or new==page:raise ValueError('Incomplete message pagination')
   page=new
  raise ValueError('Message scan limit exceeded')
 def send_text(self,chat_id,text,release_id):
  import json
  # Ensure an app token through a harmless read, never a human user token.
  if self.token is None:self._api('im/v1/chats/'+chat_id)
  d=self.transport('POST','https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',{'receive_id':chat_id,'msg_type':'text','content':json.dumps({'text':text},ensure_ascii=False),'uuid':release_id},{'Authorization':'Bearer '+self.token})
  if d.get('code')!=0 or not d.get('data',{}).get('message_id'):raise ValueError('Notification uncertain; no automatic approval')
  return d['data']['message_id']
