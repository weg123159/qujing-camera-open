import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,webcrypto} from 'node:crypto';
import {MessageChannel} from 'node:worker_threads';
import {buildOfflineManifest} from '../scripts/build-offline-manifest.mjs';
import {createOfflineManager} from '../dist/offline.mjs';

const workerSource=await readFile(new URL('../dist/sw.js',import.meta.url),'utf8');
const factory=vm.runInNewContext(`${workerSource}\ncreateOfflineRuntime;`,{URL,Request,Response,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout});
const digest=value=>createHash('sha256').update(value).digest('hex');
const scope='https://camera.example/app/';
const sleep=()=>new Promise(resolve=>setImmediate(resolve));

class MemoryCache {
 constructor(){this.items=new Map();this.failPut=null;}
 async match(key){return this.items.get(typeof key==='string'?key:key.url)?.clone();}
 async put(key,response){if(this.failPut)await this.failPut(key);this.items.set(typeof key==='string'?key:key.url,response.clone());}
 async delete(key){return this.items.delete(typeof key==='string'?key:key.url);}
}
class MemoryCaches {
 constructor(){this.items=new Map();this.created=null;}
 async keys(){return [...this.items.keys()];}
 async open(name){if(!this.items.has(name)){const cache=new MemoryCache();this.items.set(name,cache);this.created?.(cache,name);}return this.items.get(name);}
 async delete(name){return this.items.delete(name);}
}
function fixture() {
 const bodies=new Map([['index.html','<!doctype html><title>取景</title>'],['offline.mjs','export const ready=true;'],['assets/model.bin',new Uint8Array([0,1,2,3,4,5,6])]]);
 const assets=[...bodies].map(([url,data])=>({url,bytes:Buffer.byteLength(data),sha256:digest(data)}));
 const workerHash='1'.repeat(64);
 const version=digest(JSON.stringify({schema:1,assets,workerHash}));
 const manifest={schema:1,version,workerHash,assets,totalFiles:assets.length,totalBytes:assets.reduce((s,x)=>s+x.bytes,0)};
 const cacheStorage=new MemoryCaches();
 const calls=[],events=[];let override=null,active=0,maxActive=0,claimed=0;
 const runtime=factory({scope,build:version,workerHash,caches:cacheStorage,crypto:webcrypto,
  fetch:async(url,options)=>{
   calls.push({url,options});active++;maxActive=Math.max(maxActive,active);
   try {
    await sleep();
    const special=await override?.(url,options);if(special)return special;
    if(url===new URL('offline-manifest.json',scope).href)return new Response(JSON.stringify(manifest),{headers:{'Content-Type':'application/json'}});
    const rel=url.slice(scope.length);return bodies.has(rel)?new Response(bodies.get(rel)):new Response('missing',{status:404});
   } finally {active--;}
  },broadcast:async value=>{events.push(value);},claim:async()=>{claimed++;},
 });
 return {runtime,manifest,bodies,caches:cacheStorage,calls,events,setOverride:value=>{override=value;},get maxActive(){return maxActive;},get claimed(){return claimed;}};
}

async function generatorFixture(callback) {
 const root=await mkdtemp(path.join(tmpdir(),'qujing-offline-'));
 try {
  await writeFile(path.join(root,'sw.js'),workerSource);
  await writeFile(path.join(root,'index.html'),'<title>取景</title>');
  await writeFile(path.join(root,'offline.mjs'),'export const cache=true;');
  await mkdir(path.join(root,'assets'));
  await writeFile(path.join(root,'assets','model.bin'),new Uint8Array([1,2,3,4]));
  await callback(root);
 } finally {await rm(root,{recursive:true,force:true});}
}

test('offline manifest generation is deterministic and stamps the worker on asset changes',async()=>{
 await generatorFixture(async root=>{
  const first=await buildOfflineManifest(root);const worker=await readFile(path.join(root,'sw.js'),'utf8');
  const second=await buildOfflineManifest(root);assert.equal(first.version,second.version);assert.equal(await readFile(path.join(root,'sw.js'),'utf8'),worker);
  assert.ok(worker.includes(first.version));assert.ok(worker.includes(first.workerHash));
  await writeFile(path.join(root,'assets','model.bin'),new Uint8Array([4,3,2,1]));
  const third=await buildOfflineManifest(root);assert.notEqual(third.version,first.version);assert.equal(third.workerHash,first.workerHash);
 });
});

test('offline manifest excludes temporary QA files and rejects missing required files',async()=>{
 await generatorFixture(async root=>{
  await writeFile(path.join(root,'qa-layout.html'),'temporary fixture');
  await writeFile(path.join(root,'.secret'),'not shipped');
  const result=await buildOfflineManifest(root);assert.equal(result.assets.some(x=>x.url.includes('qa-')||x.url.includes('.secret')),false);
  assert.equal(result.assets.some(x=>x.url==='offline-manifest.json'||x.url==='sw.js'),false);
  await rm(path.join(root,'index.html'));await assert.rejects(buildOfflineManifest(root),/Missing required/);
 });
});

test('offline packager refuses symlinked assets',async t=>{
 await generatorFixture(async root=>{
  try {
   await symlink(path.join(root,'index.html'),path.join(root,'assets','linked.html'));
  } catch (error) {
   if (process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EACCES')) {
    t.skip('Windows permissions do not permit creating the symlink needed for this test');
    return;
   }
   throw error;
  }
  await assert.rejects(buildOfflineManifest(root),/symlinks/);
 });
});

test('ready is only published after all model and page bytes pass SHA-256 and cache writes',async()=>{
 const f=fixture();assert.equal((await f.runtime.status()).ready,false);
 const result=await f.runtime.prepare();assert.equal(result.ready,true);assert.equal(result.completed,3);assert.equal(result.bytes,f.manifest.totalBytes);
 const firstReady=f.events.findIndex(x=>x.ready);assert.ok(firstReady>0);assert.ok(f.events.slice(0,firstReady).every(x=>!x.ready));
 assert.equal((await f.runtime.status()).ready,true);assert.equal(f.calls.length,4);
 for(const call of f.calls){assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');}
});

test('repeated preparation shares one promise and downloads in sequence',async()=>{
 const f=fixture();const first=f.runtime.prepare(),second=f.runtime.prepare();assert.equal(first,second);
 await Promise.all([first,second]);assert.equal(f.maxActive,1);assert.equal(f.calls.length,4);
 await f.runtime.prepare();assert.equal(f.calls.length,4);
});

test('wrong model hash never yields ready and preserves prior version',async()=>{
 const f=fixture();const oldName=`${f.runtime.prefix}old-complete`;await f.caches.open(oldName);
 f.setOverride(url=>url.endsWith('model.bin')?new Response(new Uint8Array([6,5,4,3,2,1,0])):null);
 await assert.rejects(f.runtime.prepare(),/资源校验失败/);
 assert.equal((await f.runtime.status()).ready,false);assert.equal(f.events.some(x=>x.ready),false);
 assert.ok((await f.caches.keys()).includes(oldName));assert.equal((await f.caches.keys()).includes(f.runtime.cacheName),false);
});

test('short body and HTTP failures cannot become a complete offline cache',async()=>{
 for(const response of [new Response(new Uint8Array([1])),new Response('forbidden',{status:403})]){
  const f=fixture();f.setOverride(url=>url.endsWith('model.bin')?response:null);await assert.rejects(f.runtime.prepare());assert.equal((await f.runtime.status()).ready,false);
 }
});

test('redirected authentication HTML is refused even with HTTP 200',async()=>{
 const f=fixture();const response=new Response('<html>Sign in</html>');Object.defineProperty(response,'redirected',{value:true});
 f.setOverride(url=>url.endsWith('offline-manifest.json')?response:null);await assert.rejects(f.runtime.prepare(),/重定向/);assert.equal(f.calls.length,1);
});

test('a failed partial download is retryable without accepting leftover pieces',async()=>{
 const f=fixture();f.setOverride(url=>{if(url.endsWith('model.bin'))throw new Error('offline');});
 await assert.rejects(f.runtime.prepare());assert.equal((await f.runtime.status()).ready,false);
 f.setOverride(null);await f.runtime.prepare();assert.equal((await f.runtime.status()).ready,true);
});

test('storage quota failures preserve the old cache and report no success',async()=>{
 const f=fixture();const old=`${f.runtime.prefix}previous`;await f.caches.open(old);
 f.caches.created=cache=>{cache.failPut=key=>{if(key.endsWith('model.bin'))throw Object.assign(new Error('full'),{name:'QuotaExceededError'});};};
 await assert.rejects(f.runtime.prepare(),{name:'QuotaExceededError'});assert.ok((await f.caches.keys()).includes(old));assert.ok(f.events.at(-1).message.includes('空间不足'));assert.equal(f.events.some(x=>x.ready),false);
});

test('manifest content tampering is detected before asset downloads',async()=>{
 const f=fixture();f.manifest.assets[0].sha256='0'.repeat(64);
 await assert.rejects(f.runtime.prepare(),/清单校验/);assert.equal(f.calls.length,1);
});

test('manifest paths may not escape scope or contain ambiguous query/encoded traversal',async()=>{
 for(const bad of ['../outside','https://other.test/a','assets/model.bin?network=1','assets/%2e%2e/secret']){
  const f=fixture();f.manifest.assets[0].url=bad;await assert.rejects(f.runtime.prepare());assert.equal(f.calls.length,1);
 }
});

test('root and index navigation query variants are served fully offline',async()=>{
 const f=fixture();await f.runtime.prepare();const count=f.calls.length;f.setOverride(()=>{throw new Error('network must not run');});
 for(const url of [scope,`${scope}?installed=1`,`${scope}index.html?from=home`])assert.match(await (await f.runtime.respond(new Request(url))).text(),/取景/);
 assert.equal((await f.runtime.respond(new Request(`${scope}assets/model.bin?cachebust=1`))).status,200);assert.equal(f.calls.length,count);
});

test('uncached, external and mutation requests are blocked without network fallback',async()=>{
 const f=fixture();await f.runtime.prepare();const count=f.calls.length;
 assert.equal((await f.runtime.respond(new Request('https://elsewhere.test/api'))).status,403);
 assert.equal((await f.runtime.respond(new Request(`${scope}upload`,{method:'POST',body:'private frame'}))).status,403);
 assert.equal((await f.runtime.respond(new Request(`${scope}missing.bin`))).status,503);assert.equal(f.calls.length,count);
});

test('evicted entries revoke ready and explicit repair rechecks and restores the complete cache',async()=>{
 const f=fixture();await f.runtime.prepare();const cache=await f.caches.open(f.runtime.cacheName);
 await cache.delete(`${scope}assets/model.bin`);assert.equal((await f.runtime.status()).ready,false);assert.equal((await f.runtime.respond(new Request(`${scope}assets/model.bin`))).status,503);
 await f.runtime.prepare({repair:true});assert.equal((await f.runtime.status()).ready,true);
});

test('only successful activation retires previous caches in the same app scope',async()=>{
 const f=fixture();const old=`${f.runtime.prefix}previous`;await f.caches.open(old);await f.caches.open('another-application');
 await assert.rejects(f.runtime.activate());assert.ok((await f.caches.keys()).includes(old));assert.equal(f.claimed,0);
 await f.runtime.prepare();assert.ok((await f.caches.keys()).includes(old));await f.runtime.activate();assert.equal((await f.caches.keys()).includes(old),false);assert.ok((await f.caches.keys()).includes('another-application'));assert.equal(f.claimed,1);
});

function clientFixture({bundled=false,waiting=false,initialReady=true}={}) {
 const events=[];let checks=0,registers=0,updates=0;
 const worker={scriptURL:`${scope}sw.js`,state:'activated',postMessage(data,ports){queueMicrotask(()=>ports[0].postMessage({channel:'qujing-offline',state:initialReady?'ready':'incomplete',ready:initialReady,version:'test',completed:initialReady?3:0,total:3}));}};
 const registration={active:worker,waiting:waiting?{...worker}:null,installing:null,update:async()=>{updates++;}};
 const sw={controller:worker,addEventListener(){},removeEventListener(){},getRegistration:async()=>{checks++;return registration;},register:async()=>{registers++;return registration;}};
 const manager=createOfflineManager({bundled,baseURL:scope,secureContext:true,navigatorObject:{serviceWorker:sw,storage:{persisted:async()=>false,persist:async()=>false}},MessageChannelClass:MessageChannel,onStatus:s=>events.push(s)});
 return {manager,registration,sw,events,get checks(){return checks;},get registers(){return registers;},get updates(){return updates;}};
}

test('native bundled mode never touches service-worker registration or network preparation',async()=>{
 const f=clientFixture({bundled:true});assert.equal((await f.manager.start()).state,'bundled');assert.equal((await f.manager.prepare()).ready,true);assert.equal(f.checks,0);assert.equal(f.registers,0);assert.equal(f.updates,0);f.manager.dispose();
});

test('unsupported insecure environments remain explicitly not ready',async()=>{
 const manager=createOfflineManager({secureContext:false,navigatorObject:{},baseURL:scope});assert.equal((await manager.start()).state,'unsupported');assert.equal((await manager.prepare()).ready,false);manager.dispose();
});

test('starting the web manager checks existing cache but does not download or update',async()=>{
 const f=clientFixture();assert.equal((await f.manager.start()).ready,true);assert.equal(f.registers,0);assert.equal(f.updates,0);assert.equal(f.events.at(-1).persistent,false);f.manager.dispose();
});

test('fully prepared waiting updates do not force activation or a page reload',async()=>{
 const f=clientFixture({waiting:true});const result=await f.manager.start();assert.equal(result.state,'update-ready');assert.equal(result.ready,true);assert.match(result.message,/关闭所有/);assert.equal(f.registers,0);f.manager.dispose();
});

test('web prepare is serialized and failure preserves an existing complete version',async()=>{
 const f=clientFixture();f.sw.register=async()=>{await sleep();throw new Error('connection unavailable');};
 const a=f.manager.prepare(),b=f.manager.prepare();assert.equal(a,b);const result=await a;assert.equal(result.state,'error');assert.equal(result.ready,true);assert.match(result.message,/已有完整/);f.manager.dispose();
});

test('disposing manager closes a pending status channel without late UI feedback',async()=>{
 const f=clientFixture();f.registration.active.postMessage=()=>{};const pending=f.manager.start();await sleep();const eventCount=f.events.length;f.manager.dispose();await pending;assert.equal(f.events.length,eventCount);
});

test('first preparation waits through installed until the new worker actually activates',async()=>{
 const f=clientFixture();const worker=f.registration.active;const listeners=new Set();
 worker.state='installing';worker.addEventListener=(type,fn)=>listeners.add(fn);worker.removeEventListener=(type,fn)=>listeners.delete(fn);
 f.registration.active=null;f.registration.installing=worker;f.sw.getRegistration=async()=>null;
 let settled=false;const pending=f.manager.prepare().then(value=>{settled=true;return value;});
 await sleep();await sleep();assert.equal(listeners.size,1);
 f.registration.installing=null;f.registration.waiting=worker;worker.state='installed';for(const fn of listeners)fn();await sleep();assert.equal(settled,false);
 f.registration.waiting=null;f.registration.active=worker;worker.state='activated';for(const fn of listeners)fn();
 const result=await pending;assert.equal(result.state,'ready');assert.equal(result.ready,true);assert.equal(listeners.size,0);f.manager.dispose();
});
