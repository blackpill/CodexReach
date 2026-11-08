/** Final message I/O gate; all legacy producers share this same client instance. */
export function installChatIoQuarantine(client:any,blocked:(chatId:string)=>boolean):void {
 const apis=[client.im.message,client.im.v1?.message].filter((value,index,array)=>value && array.indexOf(value)===index);
 for(const api of apis){
 const get=api.get.bind(api);
 const assertAllowed=(chatId:unknown)=>{if(typeof chatId!=='string'||!/^oc_[A-Za-z0-9]+$/.test(chatId)||blocked(chatId))throw Error('message destination is unknown or quarantined');};
 const create=api.create.bind(api);
 api.create=async(request:any,...rest:any[])=>{
  const kind=request?.params?.receive_id_type;
  if(kind==='chat_id')assertAllowed(request?.data?.receive_id);
  else if(kind!=='open_id')throw Error('unverified message destination type');
  return create(request,...rest);
 };
 for(const name of ['reply','patch','update']) {
  if(typeof api[name]!=='function')continue;
  const original=api[name].bind(api);
  api[name]=async(request:any,...rest:any[])=>{
   const id=request?.path?.message_id;if(typeof id!=='string'||!id)throw Error('missing message identity');
   const response=await get({path:{message_id:id}});
   const message=response?.data?.items?.find((m:any)=>m.message_id===id);
   if(response?.code||!message||message.deleted)throw Error('message destination cannot be verified');
   assertAllowed(message.chat_id);
   return original(request,...rest);
  };
 }
 }
}
