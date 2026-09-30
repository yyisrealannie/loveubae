(function () {
'use strict';
const TABLE='milk_safe_messages', PROFILES='milk_safe_profiles', MEDIA='milk-chat-media';
const RECENT_LIMIT=100, PAGE_SIZE=200, MAX_CATCHUP_PER_RUN=2000;
let client=null, user=null, busy=null, merging=null, starting=null,
 lastOk=Number(localStorage.getItem('milkSafeLastOk')||0), lastError='';
let known=new Set(), queue=new Map(), mergeProgress=0, olderAvailable=true;
const device=(()=>{let d=localStorage.getItem('milkSafeDevice');if(!d){d=crypto.randomUUID();localStorage.setItem('milkSafeDevice',d)}return d})();
const auto=()=>localStorage.getItem('milkCloudAutoSync')!=='false';
const keyOf=m=>String(m.syncId||(device+':'+m.id));
const liveByKey=key=>hasMessages()?messages.find(m=>keyOf(m)===String(key)):null;
const check=r=>{if(r.error)throw r.error;return r.data};
const hasMessages=()=>typeof messages!=='undefined'&&Array.isArray(messages);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const transient=e=>/too many connections|connection|timeout|timed out|network|fetch|PGRST003|53300|temporarily unavailable/i.test(e?.message||String(e));
async function retryRead(task){
 const delays=[700,1800,4000];
 for(let attempt=0;;attempt++){
  try{return check(await task())}
  catch(e){if(attempt>=delays.length||!transient(e))throw e;await sleep(delays[attempt]+Math.floor(Math.random()*250))}
 }
}
const cursorKey=kind=>'milkSafeCursor:'+kind+':'+user.id;
const rowCursor=row=>({createdAt:row.created_at,messageKey:String(row.message_key)});
const compareCursor=(a,b)=>a.createdAt===b.createdAt?String(a.messageKey).localeCompare(String(b.messageKey)):String(a.createdAt).localeCompare(String(b.createdAt));
async function getCursor(kind){try{return await localforage.getItem(cursorKey(kind))}catch(e){report(e);return null}}
async function setCursor(kind,value){try{await localforage.setItem(cursorKey(kind),value)}catch(e){report(e)}}
async function setOlderAvailable(value){
 olderAvailable=!!value;
 try{await localforage.setItem(cursorKey('olderAvailable'),olderAvailable)}catch(e){report(e)}
}
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
function statusText(){return (merging?'正在合并云端记录'+(mergeProgress?' '+mergeProgress+' 条':''):queue.size?'正在同步 '+queue.size+' 条':lastOk?'已同步':'已连接')
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
  user=next;known=new Set();queue=new Map();olderAvailable=true;
  try{
   const [saved,olderState]=await Promise.all([
    localforage.getItem('milkSafeAck:'+user.id),
    localforage.getItem(cursorKey('olderAvailable'))
   ]);
   if(Array.isArray(saved))known=new Set(saved);
   olderAvailable=olderState!==false
  }
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
  if(merging){if(force)await merging;else return {pending:queue.size,deferred:true}}
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
async function signedUrlsFor(rows,ids){
 const paths=[];
 for(const row of rows||[]){
  if(!row.media_path)continue;
  const local=ids.get(row.message_key)||liveByKey(row.message_key);
  if(!local||!local.image||(!local._signedAt||Date.now()-local._signedAt>20*3600000))paths.push(row.media_path)
 }
 const unique=[...new Set(paths)];if(!unique.length)return new Map();
 try{
  const data=await retryRead(()=>client.storage.from(MEDIA).createSignedUrls(unique,86400));
  const urls=new Map();(data||[]).forEach((item,index)=>{if(item?.signedUrl)urls.set(item.path||unique[index],item.signedUrl)});return urls
 }catch(e){report(e);return new Map()}
}
async function absorbRows(rows,ids){
 const urls=await signedUrlsFor(rows,ids);let added=0;
 for(const row of rows||[]){
  known.add(row.message_key);
  const existing=ids.get(row.message_key)||liveByKey(row.message_key);
  if(existing){
   ids.set(row.message_key,existing);
   if(row.media_path&&urls.has(row.media_path)){existing.image=urls.get(row.media_path);existing.mediaPath=row.media_path;existing._signedAt=Date.now()}
   continue
  }
  if(!row.message||typeof row.message!=='object')continue;
  const m={...row.message,syncId:row.message_key,timestamp:new Date(row.message.timestamp||row.created_at)};
  if(row.media_path){m.mediaPath=row.media_path;if(urls.has(row.media_path)){m.image=urls.get(row.media_path);m._signedAt=Date.now()}}
  const concurrent=liveByKey(row.message_key);
  if(concurrent){ids.set(row.message_key,concurrent);continue}
  messages.push(m);ids.set(row.message_key,m);added++
 }
 return added
}
async function persistMerge(changed){
 if(changed){messages.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));if(typeof renderMessages==='function')renderMessages(true);await saveData()}
 await saveKnown();lastError='';markOk()
}
async function newestRows(limit=RECENT_LIMIT){
 const rows=await retryRead(()=>client.from(TABLE).select('message_key,message,media_path,created_at')
  .order('created_at',{ascending:false}).order('message_key',{ascending:false}).limit(limit));
 return (rows||[]).slice().reverse()
}
async function forwardRows(cursor,limit=PAGE_SIZE){
 const rows=await retryRead(()=>client.from(TABLE).select('message_key,message,media_path,created_at')
  .gte('created_at',cursor.createdAt).order('created_at',{ascending:true}).order('message_key',{ascending:true}).limit(limit+1));
 return (rows||[]).filter(row=>compareCursor(rowCursor(row),cursor)>0).slice(0,limit)
}
async function olderRows(cursor,limit=RECENT_LIMIT){
 const rows=await retryRead(()=>client.from(TABLE).select('message_key,message,media_path,created_at')
  .lte('created_at',cursor.createdAt).order('created_at',{ascending:false}).order('message_key',{ascending:false}).limit(limit+2));
 const candidates=(rows||[]).filter(row=>compareCursor(rowCursor(row),cursor)<0);
 return {rows:candidates.slice(0,limit).reverse(),more:candidates.length>limit}
}
async function mergeRemote(options={}){
 const mode=options.mode||'recent';
 if(merging){
  if(mode==='older')return merging.then(()=>mergeRemote(options));
  return merging
 }
 merging=(async()=>{
  if(!await connect())throw new Error('请先登录 Supabase');
  if(!hasMessages())return {added:0,removed:0};
  let removed=removeStableDuplicates(),added=0,more=false;
  const ids=new Map(messages.map(m=>[keyOf(m),m]));
  if(mode==='older'){
   if(!olderAvailable)return {added:0,removed,more:false,mode:'older'};
   let oldest=await getCursor('oldest');
   if(!oldest){
    const seed=await newestRows(RECENT_LIMIT+1);
    if(!seed.length){await setOlderAvailable(false);return {added:0,removed,more:false,mode:'older'}}
    const recent=seed.slice(-RECENT_LIMIT);
    oldest=rowCursor(recent[0]);await setCursor('oldest',oldest);await setOlderAvailable(seed.length>RECENT_LIMIT)
   }
   if(!olderAvailable)return {added:0,removed,more:false,mode:'older'};
   const page=await olderRows(oldest),rows=page.rows;
   added+=await absorbRows(rows,ids);mergeProgress+=rows.length;
   // 云端旧消息加入数组后，要同时扩大当前渲染窗口，才能真的出现在向上滑的位置。
   if(added&&typeof displayedMessageCount==='number')displayedMessageCount=Math.min(messages.length,displayedMessageCount+added);
   if(rows.length){await setCursor('oldest',rowCursor(rows[0]));await setOlderAvailable(page.more);await persistMerge(added||removed)}
   else await setOlderAvailable(false);
   more=page.more;
   return {added,removed,more,mode:'older'}
  }

  let cursor=await getCursor('latest'),bootstrapCursor=false;
  if(!cursor&&messages.length===0){
   const seed=await newestRows(RECENT_LIMIT+1),rows=seed.slice(-RECENT_LIMIT);
   added+=await absorbRows(rows,ids);mergeProgress+=rows.length;
   await setOlderAvailable(seed.length>RECENT_LIMIT);
   if(rows.length){await persistMerge(added||removed);await setCursor('oldest',rowCursor(rows[0]));cursor=rowCursor(rows[rows.length-1]);await setCursor('latest',cursor)}
   return {added,removed,more:false,mode:'recent',initial:true}
  }
  if(!cursor){
   const latestLocal=messages.reduce((max,m)=>Math.max(max,new Date(m.timestamp||0).getTime()||0),0);
   cursor={createdAt:new Date(Math.max(0,latestLocal-24*3600000)).toISOString(),messageKey:''};bootstrapCursor=true;
   // 已有本机历史的旧设备只补最新缺口，不再把同一批云端旧记录反复拉回。
   await setOlderAvailable(false)
  }
  let processed=0;
  while(processed<MAX_CATCHUP_PER_RUN){
   const rows=await forwardRows(cursor,Math.min(PAGE_SIZE,MAX_CATCHUP_PER_RUN-processed));
   if(!rows.length)break;
   added+=await absorbRows(rows,ids);processed+=rows.length;mergeProgress=processed;
   await persistMerge(added||removed);
   if(!await getCursor('oldest'))await setCursor('oldest',rowCursor(rows[0]));
   cursor=rowCursor(rows[rows.length-1]);await setCursor('latest',cursor);
   if(rows.length<PAGE_SIZE)break
  }
  // 旧设备第一次升级后即使没有新行，也要记住已检查的位置，避免每次回前台都重复扫描 24 小时窗口。
  if(bootstrapCursor&&processed===0)await setCursor('latest',cursor);
  more=processed>=MAX_CATCHUP_PER_RUN;
  return {added,removed,more,mode:'recent'}
 })().finally(()=>{merging=null;mergeProgress=0;status()});
 return merging
}
const mergeOlder=()=>mergeRemote({mode:'older'});
function profilePayload(){
 if(typeof customReplies==='undefined')return null;
 const source={customReplies,customReplyGroups:window.customReplyGroups||[],
  disabledReplyItems:(()=>{try{return JSON.parse(localStorage.getItem('disabledReplyItems')||'[]')}catch(_){return[]}})(),
  disabledReplyItemsUpdatedAt:Number(localStorage.getItem('disabledReplyItemsUpdatedAt')||0),
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
 if(Array.isArray(p.disabledReplyItems)&&!localStorage.getItem('disabledReplyItems')){
  localStorage.setItem('disabledReplyItems',JSON.stringify(p.disabledReplyItems));
  if(p.disabledReplyItemsUpdatedAt)localStorage.setItem('disabledReplyItemsUpdatedAt',String(p.disabledReplyItemsUpdatedAt));
 }
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
window.MilkSafeSync={start,recordMessage,flush,mergeRemote,mergeOlder,hasOlder:()=>olderAvailable,statusText,syncProfile};
})();
