import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNativeHost, createNativePhotoSaver, MAX_NATIVE_PHOTO_BYTES } from '../dist/native-bridge.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const jpeg=()=>new Blob([Uint8Array.from([255,216,255,217])],{type:'image/jpeg'});
const encodeBlob=async blob=>`data:image/jpeg;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
class Scope extends EventTarget {
 constructor(){
  super();this.location={origin:'https://appassets.androidplatform.net',pathname:'/www/index.html'};
  this.Blob=Blob;this.AbortController=AbortController;this.calls=[];this.infoReads=0;
  this.QujingNative={getInfo:()=>{this.infoReads++;return JSON.stringify({platform:'android',version:'0.5.0',bundledOffline:true,networkPermission:false,savePhoto:true});},savePhoto:(url,id)=>this.calls.push({url,id})};
 }
 result(requestId,status,message){const event=new Event('qujing-native-save');event.detail={requestId,status,message};this.dispatchEvent(event);}
}
function saver(scope=new Scope(),options={}){
 const statuses=[];const s=createNativePhotoSaver({scope,host:detectNativeHost(scope),encodeBlob,onStatus:v=>statuses.push(v),...options});
 return {scope,s,statuses};
}

test('native host is detected only at the exact packaged HTTPS origin and www path',()=>{
 const scope=new Scope();const host=detectNativeHost(scope);assert.equal(host.bridge,scope.QujingNative);
 assert.deepEqual(host.info,{platform:'android',version:'0.5.0',bundledOffline:true,networkPermission:false,savePhoto:true});
 assert.ok(Object.isFrozen(host.info));
 for(const [origin,pathname] of [
  ['http://appassets.androidplatform.net','/www/index.html'],
  ['https://appassets.androidplatform.net.evil.example','/www/index.html'],
  ['https://appassets.androidplatform.net:444','/www/index.html'],
  ['https://qujing-frame-camera.cuddlybeech.chatgpt.site','/www/index.html'],
  ['https://appassets.androidplatform.net','/other/index.html'],
  ['https://appassets.androidplatform.net','/www-evil/index.html'],
 ]){
  scope.location={origin,pathname};const before=scope.infoReads;assert.equal(detectNativeHost(scope),null);assert.equal(scope.infoReads,before);
 }
});

test('native info must parse and explicitly declare Android bundled offline without network permission',()=>{
 for(const raw of ['bad',null,JSON.stringify({platform:'android',version:'0.5.0',bundledOffline:true,networkPermission:true}),JSON.stringify({platform:'android',version:'0.5.0',bundledOffline:false,networkPermission:false}),JSON.stringify({platform:'other',version:'0.5.0',bundledOffline:true,networkPermission:false})]){
  const scope=new Scope();scope.QujingNative.getInfo=()=>raw;assert.equal(detectNativeHost(scope),null);
 }
 const scope=new Scope();scope.QujingNative.getInfo=()=>{throw new Error('bridge unavailable');};assert.equal(detectNativeHost(scope),null);
 scope.QujingNative=null;assert.equal(detectNativeHost(scope),null);
});

test('bridge invocation alone stays pending until a matching native saved event',async()=>{
 const {scope,s,statuses}=saver();let completed=false;
 const result=s.save(jpeg()).then(value=>{completed=true;return value;});await tick();
 assert.equal(scope.calls.length,1);assert.equal(s.pending,true);assert.equal(completed,false);
 const {url,id}=scope.calls[0];assert.ok(url.startsWith('data:image/jpeg;base64,'));assert.match(id,/^[A-Za-z0-9_-]{1,80}$/);
 assert.equal(statuses.at(-1).status,'pending');scope.result(id,'saved','照片已保存到所选位置。');
 assert.equal((await result).status,'saved');assert.equal(s.pending,false);assert.equal(statuses.at(-1).message,'照片已保存到所选位置。');s.dispose();
});

test('wrong request IDs and unknown completion statuses cannot complete a save',async()=>{
 const {scope,s,statuses}=saver();const result=s.save(jpeg());await tick();const id=scope.calls[0].id;
 scope.result('old-request','saved');scope.result(id,'success');scope.result(id,'pending');await tick();
 assert.equal(s.pending,true);assert.equal(statuses.length,1);scope.result(id,'cancelled');assert.equal((await result).status,'cancelled');s.dispose();
});

test('duplicate save returns busy and does not encode or launch another picker',async()=>{
 let encodes=0;const {scope,s,statuses}=saver(new Scope(),{encodeBlob:async b=>{encodes++;return encodeBlob(b);}});
 const first=s.save(jpeg());const second=await s.save(jpeg());await tick();
 assert.equal(second.status,'busy');assert.equal(encodes,1);assert.equal(scope.calls.length,1);assert.equal(statuses.length,1);
 scope.result(scope.calls[0].id,'saved');await first;s.dispose();
});

test('native cancellation and write error preserve a retryable save channel',async()=>{
 const {scope,s,statuses}=saver();
 for(const status of ['cancelled','error','saved']){
  const pending=s.save(jpeg());await tick();scope.result(scope.calls.at(-1).id,status);
  assert.equal((await pending).status,status);assert.equal(s.pending,false);assert.equal(statuses.at(-1).status,status);
 }
 assert.equal(new Set(scope.calls.map(v=>v.id)).size,3);s.dispose();
});

test('old or duplicate completion cannot finish a subsequent photo',async()=>{
 const {scope,s}=saver();const first=s.save(jpeg());await tick();const old=scope.calls[0].id;scope.result(old,'saved');await first;
 const second=s.save(jpeg());await tick();scope.result(old,'saved');assert.equal(s.pending,true);
 scope.result(scope.calls[1].id,'cancelled');assert.equal((await second).status,'cancelled');s.dispose();
});

test('only nonempty bounded JPEG Blobs can reach the bridge',async()=>{
 const {scope,s}=saver();
 for(const value of [{type:'image/jpeg',size:4},new Blob([],{type:'image/jpeg'}),new Blob(['png'],{type:'image/png'}),new Blob([new Uint8Array(MAX_NATIVE_PHOTO_BYTES+1)],{type:'image/jpeg'})]){
  assert.equal((await s.save(value)).status,'error');assert.equal(s.pending,false);
 }
 assert.equal(scope.calls.length,0);s.dispose();
});

test('encoding failure, altered MIME and malformed Base64 never invoke native save',async()=>{
 for(const encode of [async()=>{throw new Error('read');},async()=> 'data:image/png;base64,/9j/2Q==',async()=> 'data:image/jpeg;base64,%%%%',async()=> 'data:image/jpeg;base64,AAAA',async()=> 'data:image/jpeg;base64,AAAAAAAA']){
  const {scope,s}=saver(new Scope(),{encodeBlob:encode});assert.equal((await s.save(jpeg())).status,'error');assert.equal(scope.calls.length,0);assert.equal(s.pending,false);s.dispose();
 }
});

test('native invocation error reports failure without losing the ability to retry',async()=>{
 const scope=new Scope();scope.QujingNative.savePhoto=()=>{throw new Error('native invocation');};const {s}=saver(scope);
 assert.equal((await s.save(jpeg())).status,'error');assert.equal(s.pending,false);
 scope.QujingNative.savePhoto=(url,id)=>scope.calls.push({url,id});const retry=s.save(jpeg());await tick();scope.result(scope.calls[0].id,'saved');assert.equal((await retry).status,'saved');s.dispose();
});

test('pagehide cancels encoding and late bytes cannot invoke the native picker',async()=>{
 let encoded,signal;const {scope,s,statuses}=saver(new Scope(),{encodeBlob:(_blob,options)=>{signal=options.signal;return new Promise(resolve=>{encoded=resolve;});}});
 const pending=s.save(jpeg());await tick();scope.dispatchEvent(new Event('pagehide'));assert.equal((await pending).status,'cancelled');assert.equal(signal.aborted,true);
 const count=statuses.length;encoded(await encodeBlob(jpeg()));await tick();assert.equal(scope.calls.length,0);assert.equal(statuses.length,count);assert.equal(s.pending,false);
 assert.equal((await s.save(jpeg())).status,'error');s.dispose();
});

test('dispose cancels a native picker wait and removes completion handling',async()=>{
 const {scope,s,statuses}=saver();const pending=s.save(jpeg());await tick();const id=scope.calls[0].id;
 s.dispose();assert.equal((await pending).status,'cancelled');assert.equal(s.pending,false);const count=statuses.length;
 scope.result(id,'saved');scope.dispatchEvent(new Event('pagehide'));assert.equal(statuses.length,count);s.dispose();
});

test('default FileReader path sends actual bytes and aborts safely on pagehide',async()=>{
 const scope=new Scope();let instance;
 scope.FileReader=class {
  constructor(){instance=this;this.result=null;this.aborts=0;}
  readAsDataURL(blob){this.blob=blob;}
  abort(){this.aborts++;this.onabort?.();}
 };
 const statuses=[];const s=createNativePhotoSaver({scope,onStatus:v=>statuses.push(v)});
 const first=s.save(jpeg());await tick();assert.ok(instance.blob instanceof Blob);
 instance.result=await encodeBlob(instance.blob);instance.onload();await tick();assert.equal(scope.calls.length,1);
 scope.result(scope.calls[0].id,'saved');assert.equal((await first).status,'saved');
 const second=s.save(jpeg());await tick();const reader=instance;scope.dispatchEvent(new Event('pagehide'));
 assert.equal((await second).status,'cancelled');assert.equal(reader.aborts,1);assert.equal(reader.onload,null);assert.equal(scope.calls.length,1);
});

test('missing native host reports unsupported and UI callback failures do not strand waits',async()=>{
 const scope=new Scope();scope.location.origin='https://example.com';const unsupported=createNativePhotoSaver({scope});
 assert.equal((await unsupported.save(jpeg())).status,'error');assert.equal(scope.calls.length,0);unsupported.dispose();
 const actual=new Scope();const {s}=saver(actual,{onStatus:()=>{throw new Error('UI');}});const pending=s.save(jpeg());await tick();actual.result(actual.calls[0].id,'saved');assert.equal((await pending).status,'saved');s.dispose();
});

test('supplied bridge and delayed encoding cannot bypass the packaged location boundary',async()=>{
 const scope=new Scope();const host=detectNativeHost(scope);scope.location.origin='https://example.com';
 const outside=createNativePhotoSaver({scope,host,encodeBlob});assert.equal((await outside.save(jpeg())).status,'error');assert.equal(scope.calls.length,0);outside.dispose();
 const valid=new Scope();let finish;const {s}=saver(valid,{encodeBlob:()=>new Promise(resolve=>{finish=resolve;})});
 const pending=s.save(jpeg());await tick();valid.location.pathname='/outside';finish(await encodeBlob(jpeg()));
 assert.equal((await pending).status,'error');assert.equal(valid.calls.length,0);s.dispose();
});

test('synchronous native completion is correlated and never missed',async()=>{
 const scope=new Scope();scope.QujingNative.savePhoto=(_url,id)=>scope.result(id,'saved');const {s,statuses}=saver(scope);
 assert.equal((await s.save(jpeg())).status,'saved');assert.deepEqual(statuses.map(v=>v.status),['pending','saved']);s.dispose();
});
