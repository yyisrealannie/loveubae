(function () {
'use strict';
const TABLE='milk_safe_messages', PROFILES='milk_safe_profiles', MEDIA='milk-chat-media';
let client=null, user=null, busy=null, merging=null, starting=null,
 lastOk=Number(localStorage.getItem('milkSafeLastOk')||0), lastError='';
let known=new Set(), queue=new Map();
const device=(()=>{let d=localStorage.getItem('milkSafeDevice');if(!d){d=crypto.randomUUID();localStorage.setItem('milkSafeDevice',d)}return d})();
const auto=()=>localStorage.getItem('milkCloudAutoSync')!=='false';
const keyOf=m=>String(m.syncId||(device+':'+m.id));
const liveByKey=key=>hasMessages()?messages.find(m=>keyOf(m)===String(key)):null;
const check=r=>{if(r.error)throw r.error;return r.data};
const hasMessages=()=>typeof messages!=='undefined'&&Array.isArray(messages);
function removeStableDuplicates(){
 if(!hasMessages())return 0;
 const seen=new Map();let removed=0;
 for(let i=0;i<messages.length;i++){
  const current=messages[i],id=current?.syncId;
  if(id==null||id==='')continue;
  const key=String(id);
  if(seen.has(key)){
   const kept=seen.get(key);
   // 保留两份中更完整的本地信息，再移除重复对象。
   if(!kept.image&&current.image)kept.image=current.image;
   if(!kept.mediaPath&&current.mediaPath)kept.mediaPath=current.mediaPath;
   if(!kept.note&&current.note)kept.note=current.note;
   if(!kept.replyTo&&current.replyTo)kept.replyTo=current.replyTo;
   if(current.favorited)kept.favorited=true;
   if(current.status==='read')kept.status='read';
   messages.splice(i,1);i--;removed++
  }
  else seen.set(key,current)
 }
 return removed
}
function markOk(){lastOk=Date.now();localStorage.setItem('milkSafeLastOk',String(lastOk));status()}
function statusText(){return (queue.size?'正在同步 '+queue.size+' 条':lastOk?'已同步':'已连接')
 +(lastError?' · ⚠️ '+lastError.slice(0,70):'')}
function status(){if(!user)return;for(const id of ['cloud-sync-inline-status','cloud-sync-status']){const e=document.getElementById(id);if(e)e.textContent=statusText()}}
function report(e){lastError=e?.message||String(e);console.warn('[safe-sync]',e);status()}
async function connect(){
 client=window.MilkCloudSync?.getClient();
 const next=client?await window.MilkCloudSync.currentUser():null;
 if(!next){user=null;return false}
 const bound=localStorage.getItem('milkSafeBoundUser');
 if(bound && bound!==next.id)throw new Error('此设备已有另一账号的本机记录，已阻止跨账号上传，请先保留原设备数据');
 if(!bound)localStorage.setItem('milkSafeBoundUser',next.id);
 if(user?.id!==next.id){
  user=next;known=new Set();queue=new Map();
  try{const saved=await localforage.getItem('milkSafeAck:'+user.id);if(Array.isArray(saved))known=new Set(saved)}
  catch(e){report(e)}
 }
 return true
}
function enqueue(m){if(!m||m.id==null||m.type==='wallet-transfer')return;const k=keyOf(m);if(!known.has(k))queue.set(k,m)}
function recordMessage(m){if(m&&m.id!=null&&!m.syncId)m.syncId=crypto.randomUUID();enqueue(m);if(m&&m.id!=null&&queue.has(keyOf(m)))queue=new Map([[keyOf(m),m],...queue]);status();if(auto()&&user)setTimeout(()=>flush().catch(report),0)}
async function mediaFor(m,key){
 if(typeof m.image!=='string'||!m.image.startsWith('data:'))return null;
 const match=new RegExp('^data:(image/(?:jpeg|png|webp|gif));base64,','i').exec(m.image);
 if(!match)throw new Error('图片格式不支持云端增量保存，本机原图未改动');
 if(m.image.length>11*1024*1024)throw new Error('图片超过 8 MB 云端限制，本机原图未改动');
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
 const filename=[...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
 const mime=match[1].toLowerCase(),ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[mime];
 const path=user.id+'/'+filename+'.'+ext,blob=await(await fetch(m.image)).blob();
 if(blob.size>8388608)throw new Error('图片超过 8 MB 云端限制，本机原图未改动');
 const result=await client.storage.from(MEDIA).upload(path,blob,{contentType:mime,upsert:false});
 if(result.error&&!/already exists|duplicate/i.test(result.error.message||''))throw result.error;
 return path
}
async function sendOne(key,m){
 if(known.has(key)){queue.delete(key);return}
 if(m.image!=null&&typeof m.image!=='string')throw new Error('这条消息含尚不支持的附件，本机原件保留，未标记已同步');
 const path=await mediaFor(m,key),copy={...m,image:null};
 if(path)copy.mediaPath=path;else if(typeof m.image==='string')copy.image=m.image;
 const json=JSON.stringify(copy);
 if(json.length>1000000)throw new Error('一条消息过大，未上传但仍保留本机原件');
 check(await client.from(TABLE).upsert({user_id:user.id,message_key:key,message:JSON.parse(json),media_path:path},
 {onConflict:'user_id,message_key',ignoreDuplicates:true}));
 known.add(key);queue.delete(key)
}
async function saveKnown(){try{await localforage.setItem('milkSafeAck:'+user.id,[...known].slice(-50000))}catch(e){report(e)}}
async function flush(force=false){
 if(busy)return busy;
 busy=(async()=>{
  if(!await connect())throw new Error('请先登录 Supabase');
  if(!force&&!auto())return {pending:queue.size};
  if(hasMessages())messages.forEach(enqueue);
  let sent=0,attempted=0;
  for(const [k,m] of queue){
   if(attempted++>=(force?400:50))break;
   try{await sendOne(k,m);sent++;lastError='';markOk()}
   catch(e){report(e);if(!/图片|过大|不支持|附件/.test(lastError))break}
  }
  if(sent)await saveKnown();status();return {sent,pending:queue.size,error:lastError}
 })().finally(()=>{busy=null});
 return busy
}
async function mergeRemote(){
 if(merging)return merging;
 merging=(async()=>{
  if(!await connect())throw new Error('请先登录 Supabase');
  if(!hasMessages())return {added:0};
  // 上一次并发回填若留下了相同稳定 ID 的副本，在读取云端前先安全收拢。
  // 不按文字判断，用户有意重复发送的内容不会被删除。
  let removed=removeStableDuplicates(),added=0,page=0,ids=new Map(messages.map(m=>[keyOf(m),m]));
  while(page<100){
   const rows=check(await client.from(TABLE).select('message_key,message,media_path,created_at')
    .order('created_at',{ascending:true}).order('message_key',{ascending:true}).range(page*100,page*100+99));
   for(const row of rows||[]){
    known.add(row.message_key);
    // ids 是本轮开始时的快照；发送可能在查询等待期间发生，所以必须检查实时数组。
    const existing=ids.get(row.message_key)||liveByKey(row.message_key);
    if(existing){
     ids.set(row.message_key,existing);
     const local=existing;
     if(row.media_path && (!local.image || /^https:/.test(local.image)) && (!local._signedAt || Date.now()-local._signedAt>20*3600000)){
      try{local.image=check(await client.storage.from(MEDIA).createSignedUrl(row.media_path,86400)).signedUrl;local._signedAt=Date.now()}
      catch(e){report(e)}
     }
     continue;
    }
    const m=row.message;
    if(!m||typeof m!=='object')continue;
    m.syncId=row.message_key;
    if(row.media_path){
     m.mediaPath=row.media_path;
     try{m.image=check(await client.storage.from(MEDIA).createSignedUrl(row.media_path,86400)).signedUrl;m._signedAt=Date.now()}
     catch(e){report(e)}
    }
    m.timestamp=new Date(m.timestamp||row.created_at);
    // 签名 URL 的 await 期间也可能刚好产生本地消息，写入前再做最后一次实时检查。
    const concurrent=liveByKey(row.message_key);
    if(concurrent){
     ids.set(row.message_key,concurrent);
     if(row.media_path&&m.image&&!concurrent.image){concurrent.image=m.image;concurrent.mediaPath=row.media_path;concurrent._signedAt=m._signedAt}
     continue
    }
    messages.push(m);ids.set(row.message_key,m);added++
   }
   if(!rows||rows.length<100)break;page++
  }
  if(added||removed){
   messages.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
   if(typeof renderMessages==='function')renderMessages(true);
   try{await saveData()}catch(e){report(e)}
  }
  await saveKnown();status();return {added,removed}
 })().finally(()=>{merging=null});
 return merging
}
function profilePayload(){
 if(typeof customReplies==='undefined')return null;
 const source={customReplies,customReplyGroups:window.customReplyGroups||[],
  customEmojis:typeof customEmojis==='undefined'?[]:customEmojis,
  customPokes:typeof customPokes==='undefined'?[]:customPokes,
  myPokes:typeof myPokes==='undefined'?[]:myPokes,
  customStatuses:typeof customStatuses==='undefined'?[]:customStatuses,
  settings:typeof settings==='undefined'?{}:{partnerName:settings.partnerName,myName:settings.myName,replyEnabled:settings.replyEnabled}};
 const json=JSON.stringify(source,(k,v)=>typeof v==='string'&&v.length>12000?undefined:v);
 if(json.length>750000)throw new Error('字卡设置过大，无法安全上传整份；聊天消息仍单独保存');
 return json
}
async function syncProfile(){
 if(!await connect())return;
 const text=profilePayload();if(!text)return;
 let hash=2166136261;
 for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
 const marker=text.length+':'+(hash>>>0);
 if(localStorage.getItem('milkSafeProfileAck:'+user.id)===marker)return;
 check(await client.from(PROFILES).insert({user_id:user.id,device_id:device,profile:JSON.parse(text)}));
 localStorage.setItem('milkSafeProfileAck:'+user.id,marker)
}
async function restoreProfileIfEmpty(){
 if(!hasMessages()||messages.length||(typeof customReplies!=='undefined'&&customReplies.length))return;
 const rows=check(await client.from(PROFILES).select('profile').order('created_at',{ascending:false}).limit(1));
 const p=rows?.[0]?.profile;if(!p)return;
 if(Array.isArray(p.customReplies))customReplies=p.customReplies;
 if(Array.isArray(p.customReplyGroups))window.customReplyGroups=p.customReplyGroups;
 if(Array.isArray(p.customEmojis))customEmojis=p.customEmojis;
 if(Array.isArray(p.customPokes))customPokes=p.customPokes;
 if(Array.isArray(p.myPokes))myPokes=p.myPokes;
 if(Array.isArray(p.customStatuses))customStatuses=p.customStatuses;
 if(p.settings&&typeof p.settings==='object')Object.assign(settings,p.settings);
 try{await saveData();if(typeof updateUI==='function')updateUI()}catch(e){report(e)}
}
async function start(){
 if(starting)return starting;
 starting=(async()=>{
  if(!await connect())return;
  try{await restoreProfileIfEmpty();await mergeRemote();await flush();await syncProfile();markOk()}
  catch(e){report(e)}
 })().finally(()=>{starting=null});
 return starting
}
document.addEventListener('DOMContentLoaded',()=>{
 window.addEventListener('milk-app-ready',()=>{start().catch(report)});
 window.addEventListener('online',()=>{if(auto())start().catch(report)});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&auto())start().catch(report)});
 setInterval(()=>{if(!document.hidden&&auto()){flush().catch(report);syncProfile().catch(report)}},20000)
});
window.MilkSafeSync={start,recordMessage,flush,mergeRemote,statusText,syncProfile};
})();
