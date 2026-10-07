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
function imageDataInfo(value){
 if(typeof value!=='string')return null;
 const match=/^data:(image\/(?:jpeg|png|webp|gif));base64,/i.exec(value);
 if(!match)return null;
 const mime=match[1].toLowerCase();
 return {mime,ext:{'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[mime]}
}
async function hashText(value){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('')
}
function currentAvatar(type){
 try{
  const holder=type==='partner'?DOMElements.partner.avatar:DOMElements.me.avatar;
  const src=holder?.querySelector('img')?.src||'';
  return src&&src!==window.location.href&&!src.startsWith('blob:')?src:''
 }catch(_){return''}
}
function profileMediaSources(){
 const partnerAvatar=currentAvatar('partner'),myAvatar=currentAvatar('my');
 return {
  partnerAvatar,myAvatar,
  partnerAvatarFrame:typeof settings!=='undefined'?settings.partnerAvatarFrame?.src||'':'',
  myAvatarFrame:typeof settings!=='undefined'?settings.myAvatarFrame?.src||'':'',
  stickerLibrary:typeof stickerLibrary!=='undefined'&&Array.isArray(stickerLibrary)?stickerLibrary:[],
  myStickerLibrary:typeof myStickerLibrary!=='undefined'&&Array.isArray(myStickerLibrary)?myStickerLibrary:[]
 }
}
async function uploadProfileAsset(value,cache){
 if(typeof value!=='string'||!value)return null;
 if(!value.startsWith('data:'))return /^https?:\/\//i.test(value)?{url:value}:null;
 const info=imageDataInfo(value);if(!info)throw new Error('头像或表情包含不支持的图片格式');
 if(value.length>11*1024*1024)throw new Error('头像或表情包图片超过 8 MB 云端限制');
 if(cache.has(value))return cache.get(value);
 const promise=(async()=>{
  const filename=await hashText(value),path=user.id+'/profile/'+filename+'.'+info.ext;
  const blob=await(await fetch(value)).blob();
  if(blob.size>8388608)throw new Error('头像或表情包图片超过 8 MB 云端限制');
  const result=await client.storage.from(MEDIA).upload(path,blob,{contentType:info.mime,upsert:false});
  if(result.error&&!/already exists|duplicate/i.test(result.error.message||''))throw result.error;
  return {path,mime:info.mime}
 })();
 cache.set(value,promise);return promise
}
async function mapLimited(values,limit,task){
 const output=new Array(values.length);let next=0;
 async function worker(){for(;;){const index=next++;if(index>=values.length)return;output[index]=await task(values[index],index)}}
 await Promise.all(Array.from({length:Math.min(limit,values.length)},worker));return output
}
async function uploadProfileMedia(sources){
 const cache=new Map(),one=value=>uploadProfileAsset(value,cache);
 const fixed=[sources.partnerAvatar,sources.myAvatar,sources.partnerAvatarFrame,sources.myAvatarFrame];
 const all=fixed.concat(sources.stickerLibrary,sources.myStickerLibrary);
 const refs=await mapLimited(all,3,one),stickerEnd=4+sources.stickerLibrary.length;
 const [partnerAvatar,myAvatar,partnerAvatarFrame,myAvatarFrame]=refs;
 const stickers=refs.slice(4,stickerEnd),myStickers=refs.slice(stickerEnd);
 return {partnerAvatar,myAvatar,partnerAvatarFrame,myAvatarFrame,stickerLibrary:stickers,myStickerLibrary:myStickers}
}
async function blobToDataUrl(blob){
 const bytes=new Uint8Array(await blob.arrayBuffer()),chunk=0x8000;let binary='';
 for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
 return 'data:'+(blob.type||'application/octet-stream')+';base64,'+btoa(binary)
}
async function downloadProfileAsset(ref,cache){
 if(!ref)return '';
 if(typeof ref==='string')return ref;
 if(typeof ref.url==='string')return ref.url;
 if(typeof ref.path!=='string'||!ref.path)return '';
 if(cache.has(ref.path))return cache.get(ref.path);
 const promise=(async()=>{
  const blob=await retryRead(()=>client.storage.from(MEDIA).download(ref.path));
  return blobToDataUrl(blob)
 })();
 cache.set(ref.path,promise);return promise
}
async function restoreProfileMedia(media){
 if(!media||typeof media!=='object')return null;
 const cache=new Map(),one=ref=>downloadProfileAsset(ref,cache);
 const [partnerAvatar,myAvatar,partnerAvatarFrame,myAvatarFrame,stickers,myStickers]=await Promise.all([
  one(media.partnerAvatar),one(media.myAvatar),one(media.partnerAvatarFrame),one(media.myAvatarFrame),
  mapLimited(Array.isArray(media.stickerLibrary)?media.stickerLibrary:[],3,one),
  mapLimited(Array.isArray(media.myStickerLibrary)?media.myStickerLibrary:[],3,one)
 ]);
 return {partnerAvatar,myAvatar,partnerAvatarFrame,myAvatarFrame,stickerLibrary:stickers.filter(Boolean),myStickerLibrary:myStickers.filter(Boolean)}
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
 const frameMeta=frame=>frame&&typeof frame==='object'?{size:frame.size,offsetX:frame.offsetX,offsetY:frame.offsetY}:null;
 const source={customReplies,customReplyGroups:window.customReplyGroups||[],
  disabledReplyItems:(()=>{try{return JSON.parse(localStorage.getItem('disabledReplyItems')||'[]')}catch(_){return[]}})(),
  disabledReplyItemsUpdatedAt:Number(localStorage.getItem('disabledReplyItemsUpdatedAt')||0),
  customEmojis:typeof customEmojis==='undefined'?[]:customEmojis,
  customPokes:typeof customPokes==='undefined'?[]:customPokes,
  myPokes:typeof myPokes==='undefined'?[]:myPokes,
  customStatuses:typeof customStatuses==='undefined'?[]:customStatuses,
  customPokeGroups:window.customPokeGroups||[],
  customStatusGroups:window.customStatusGroups||[],
  customMottos:typeof customMottos==='undefined'?[]:customMottos,
  customIntros:typeof customIntros==='undefined'?[]:customIntros,
  anniversaries:typeof anniversaries==='undefined'?[]:anniversaries,
  settings:typeof settings==='undefined'?{}:{
   partnerName:settings.partnerName,myName:settings.myName,
   partnerStatus:settings.partnerStatus,myStatus:settings.myStatus,
   replyEnabled:settings.replyEnabled,showPartnerNameInChat:settings.showPartnerNameInChat,
   partnerAvatarShape:settings.partnerAvatarShape,myAvatarShape:settings.myAvatarShape,
   partnerAvatarFrame:frameMeta(settings.partnerAvatarFrame),myAvatarFrame:frameMeta(settings.myAvatarFrame)
  }};
 const json=JSON.stringify(source,(k,v)=>typeof v==='string'&&v.length>12000?undefined:v);
 if(json.length>750000)throw new Error('字卡设置过大，无法安全上传整份；聊天消息仍单独保存');
 return json
}
function profileMarker(text,media){
 let hash=2166136261,length=0;
 const add=value=>{const part=String(value||'');length+=part.length+1;for(let i=0;i<part.length;i++)hash=Math.imul(hash^part.charCodeAt(i),16777619);hash=Math.imul(hash^0,16777619)};
 add(text);
 if(media){
  for(const name of ['partnerAvatar','myAvatar','partnerAvatarFrame','myAvatarFrame'])add(media[name]);
  for(const name of ['stickerLibrary','myStickerLibrary']){add(name);for(const value of media[name]||[])add(value)}
 }
 return length+':'+(hash>>>0)
}
const profileReadyKey=()=>user?'milkSafeProfileReady:'+user.id:'';
async function syncProfile(){
 if(!await connect())return;
 const text=profilePayload();if(!text)return;
 // 新设备必须先完成云端资料恢复，不能先把默认昵称和空字卡传上去。
 if(localStorage.getItem(profileReadyKey())!=='1')return;
 const mediaSources=profileMediaSources(),marker=profileMarker(text,mediaSources);
 if(localStorage.getItem('milkSafeProfileAck:'+user.id)===marker)return;
 const profile=JSON.parse(text);
 profile.media=await uploadProfileMedia(mediaSources);
 profile._sync={version:3,updatedAt:new Date().toISOString()};
 check(await client.from(PROFILES).insert({user_id:user.id,device_id:device,profile}));
 localStorage.setItem('milkSafeProfileAck:'+user.id,marker)
}
function legacyProfile(rows){
 const profiles=(rows||[]).map(row=>row?.profile).filter(p=>p&&typeof p==='object');
 if(!profiles.length)return null;
 const result={...profiles[0],settings:{...(profiles[0].settings||{})}};
 const newestNonEmpty=name=>profiles.find(p=>Array.isArray(p[name])&&p[name].length);
 const cardSource=newestNonEmpty('customReplies');
 if(cardSource){
  result.customReplies=cardSource.customReplies;
  for(const name of ['customReplyGroups','disabledReplyItems','disabledReplyItemsUpdatedAt']){
   if(Object.prototype.hasOwnProperty.call(cardSource,name))result[name]=cardSource[name]
  }
 }
 for(const name of ['customEmojis','customPokes','myPokes','customStatuses','customPokeGroups','customStatusGroups','customMottos','customIntros','anniversaries']){
  const source=newestNonEmpty(name);if(source)result[name]=source[name]
 }
 const defaults={partnerName:'梦角',myName:'我'};
 for(const name of ['partnerName','myName']){
  const source=profiles.find(p=>typeof p.settings?.[name]==='string'&&p.settings[name].trim()&&p.settings[name]!==defaults[name]);
  if(source)result.settings[name]=source.settings[name]
 }
 return result
}
function applyProfile(p){
 if(!p||typeof p!=='object')return false;
 if(Array.isArray(p.customReplies))customReplies=p.customReplies;
 if(Array.isArray(p.customReplyGroups))window.customReplyGroups=p.customReplyGroups;
 if(Array.isArray(p.disabledReplyItems)){
  localStorage.setItem('disabledReplyItems',JSON.stringify(p.disabledReplyItems));
  localStorage.setItem('disabledReplyItemsUpdatedAt',String(Number(p.disabledReplyItemsUpdatedAt)||0));
 }
 if(Array.isArray(p.customEmojis))customEmojis=p.customEmojis;
 if(Array.isArray(p.customPokes))customPokes=p.customPokes;
 if(Array.isArray(p.myPokes))myPokes=p.myPokes;
 if(Array.isArray(p.customStatuses))customStatuses=p.customStatuses;
 if(Array.isArray(p.customPokeGroups))window.customPokeGroups=p.customPokeGroups;
 if(Array.isArray(p.customStatusGroups))window.customStatusGroups=p.customStatusGroups;
 if(Array.isArray(p.customMottos)&&typeof customMottos!=='undefined')customMottos=p.customMottos;
 if(Array.isArray(p.customIntros)&&typeof customIntros!=='undefined')customIntros=p.customIntros;
 if(Array.isArray(p.anniversaries)&&typeof anniversaries!=='undefined')anniversaries=p.anniversaries;
 if(p.settings&&typeof p.settings==='object'&&typeof settings!=='undefined'){
  const allowed=['partnerName','myName','partnerStatus','myStatus','replyEnabled','showPartnerNameInChat',
   'partnerAvatarShape','myAvatarShape','partnerAvatarFrame','myAvatarFrame'];
  for(const name of allowed)if(Object.prototype.hasOwnProperty.call(p.settings,name))settings[name]=p.settings[name]
  if(typeof p.settings.showPartnerNameInChat==='boolean'&&typeof showPartnerNameInChat!=='undefined'){
   showPartnerNameInChat=p.settings.showPartnerNameInChat;
   document.body?.classList?.toggle('show-partner-name',showPartnerNameInChat)
  }
 }
 window._customReplies=typeof customReplies==='undefined'?[]:customReplies;
 return true
}
function applyRestoredMedia(media){
 if(!media)return;
 if(typeof stickerLibrary!=='undefined')stickerLibrary=media.stickerLibrary;
 if(typeof myStickerLibrary!=='undefined')myStickerLibrary=media.myStickerLibrary;
 if(typeof settings!=='undefined'){
  if(settings.partnerAvatarFrame)settings.partnerAvatarFrame={...settings.partnerAvatarFrame,src:media.partnerAvatarFrame||''};
  if(settings.myAvatarFrame)settings.myAvatarFrame={...settings.myAvatarFrame,src:media.myAvatarFrame||''};
 }
 try{
  if(typeof updateAvatar==='function'&&typeof DOMElements!=='undefined'){
   updateAvatar(DOMElements.partner.avatar,media.partnerAvatar||null);
   updateAvatar(DOMElements.me.avatar,media.myAvatar||null)
  }
  if(typeof applyAllAvatarFrames==='function')applyAllAvatarFrames()
 }catch(e){report(e)}
}
function localProfileMeaningful(){
 const customName=typeof settings!=='undefined'&&(
  (typeof settings.partnerName==='string'&&settings.partnerName.trim()&&settings.partnerName!=='梦角')||
  (typeof settings.myName==='string'&&settings.myName.trim()&&settings.myName!=='我')
 );
 return !!(customName||
  (typeof customReplies!=='undefined'&&Array.isArray(customReplies)&&customReplies.length)||
  (typeof customEmojis!=='undefined'&&Array.isArray(customEmojis)&&customEmojis.length)||
  (typeof myPokes!=='undefined'&&Array.isArray(myPokes)&&myPokes.length)||
  (typeof stickerLibrary!=='undefined'&&Array.isArray(stickerLibrary)&&stickerLibrary.length)||
  (typeof myStickerLibrary!=='undefined'&&Array.isArray(myStickerLibrary)&&myStickerLibrary.length)||
  currentAvatar('partner')||currentAvatar('my'))
}
async function restoreProfileIfNeeded(){
 if(!hasMessages()||localStorage.getItem(profileReadyKey())==='1')return false;
 // 已经同步过且本机仍有明确自定义内容的老设备，以本机为准，避免升级时覆盖离线修改。
 // 旧版本误上传过“默认昵称 + 空字卡”的设备仍继续从更早快照恢复。
 if(localStorage.getItem('milkSafeProfileAck:'+user.id)&&localProfileMeaningful()){
  localStorage.setItem(profileReadyKey(),'1');return false
 }
 const rows=check(await client.from(PROFILES).select('profile,device_id,created_at').order('created_at',{ascending:false}).limit(50));
 const versioned=(rows||[]).find(row=>Number(row?.profile?._sync?.version)>=2);
 const p=versioned?.profile||legacyProfile(rows);
 let restored=false;
 if(p){
  restored=applyProfile(p);
  const restoredMedia=await restoreProfileMedia(p.media);applyRestoredMedia(restoredMedia);
  try{await saveData();if(typeof updateUI==='function')updateUI()}catch(e){report(e);throw e}
  // 完整的 v3 快照可以直接作为本机确认值；旧快照会在随后自动升级为 v3。
  if(Number(versioned?.profile?._sync?.version)>=3){
   const text=profilePayload();if(text)localStorage.setItem('milkSafeProfileAck:'+user.id,profileMarker(text,profileMediaSources()))
  }
 }
 localStorage.setItem(profileReadyKey(),'1');
 return restored
}
async function start(){
 if(starting)return starting;
 starting=(async()=>{
  if(!await connect())return;
  try{await restoreProfileIfNeeded();await mergeRemote();await flush();await syncProfile();markOk()}
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
window.MilkSafeSync={start,recordMessage,flush,mergeRemote,mergeOlder,hasOlder:()=>olderAvailable,statusText,syncProfile,restoreProfile:restoreProfileIfNeeded};
})();
