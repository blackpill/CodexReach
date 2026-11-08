import {it,expect,vi} from 'vitest';
import {installChatIoQuarantine} from './chat-io-quarantine.js';
it('blocks every reply and patch to quarantined chats at the final API boundary',async()=>{
 const create=vi.fn(),reply=vi.fn(),patch=vi.fn();const get=vi.fn(async({path}:any)=>({code:0,data:{items:[{message_id:path.message_id,chat_id:path.message_id==='old'?'oc_old':'oc_new'}]}}));
 const client={im:{message:{create,reply,patch,get}}};installChatIoQuarantine(client,id=>id==='oc_old');
 await expect(client.im.message.reply({path:{message_id:'old'}})).rejects.toThrow();await expect(client.im.message.patch({path:{message_id:'old'}})).rejects.toThrow();
 await expect(client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:'oc_old'}})).rejects.toThrow();
 expect(create).not.toHaveBeenCalled();expect(reply).not.toHaveBeenCalled();expect(patch).not.toHaveBeenCalled();
 await client.im.message.reply({path:{message_id:'new'}});expect(reply).toHaveBeenCalledTimes(1);
});
it('fails closed on unreadable or missing message source and rechecks live quarantine',async()=>{
 let blocked=false;const reply=vi.fn();const client={im:{message:{create:vi.fn(),reply,patch:vi.fn(),get:vi.fn(async()=>{blocked=true;return {code:0,data:{items:[{message_id:'m',chat_id:'oc_new'}]}};})}}};
 installChatIoQuarantine(client,()=>blocked);await expect(client.im.message.reply({path:{message_id:'m'}})).rejects.toThrow();expect(reply).not.toHaveBeenCalled();
});

it('guards the real SDK v1 alias as well as the unversioned message API',async()=>{
 const sdk=await import('@larksuiteoapi/node-sdk');const c=new sdk.Client({appId:'test',appSecret:'test'});
 for(const api of [c.im.message,c.im.v1.message] as any[]){api.create=vi.fn();api.reply=vi.fn();api.patch=vi.fn();api.get=vi.fn().mockResolvedValue({code:0,data:{items:[{message_id:'om_old',chat_id:'oc_old'}]}});}
 installChatIoQuarantine(c,id=>id==='oc_old');
 for(const api of [c.im.message,c.im.v1.message] as any[]){await expect(api.create({params:{receive_id_type:'chat_id'},data:{receive_id:'oc_old'}})).rejects.toThrow();await expect(api.reply({path:{message_id:'om_old'}})).rejects.toThrow();await expect(api.patch({path:{message_id:'om_old'}})).rejects.toThrow();}
});
