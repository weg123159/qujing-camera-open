/* Offline assets are verified before this worker can activate. Generated build stamps follow. */
const OFFLINE_BUILD = 'a5f1c1cc98ff74590d21359168661d5167327d7546e13878363e76d2686aa676';
const OFFLINE_WORKER_SOURCE_HASH = '303eb138d10a5f6b6be82b97061bd7dc9eb5e1e29c0dc8d97533ba0a36296929';
const OFFLINE_CHANNEL = 'qujing-offline';

function createOfflineRuntime(environment) {
  const scope = new URL(environment.scope);
  const prefix = `qujing-offline-v1-${encodeURIComponent(scope.pathname)}-`;
  const cacheName = `${prefix}${environment.build}`;
  const manifestURL = new URL('offline-manifest.json', scope).href;
  const readyURL = new URL('.__qujing_offline_ready__', scope).href;
  let pending = null;
  let progress = {state:'idle',ready:false,completed:0,total:0,bytes:0,totalBytes:0,version:environment.build};
  const digest = async bytes => Array.from(new Uint8Array(await environment.crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2,'0')).join('');
  const publish = async values => {
    progress = {...progress,...values};
    await environment.broadcast?.({channel:OFFLINE_CHANNEL,...progress});
    return {...progress};
  };
  const failure = message => new Error(message);
  const assetURL = value => {
    if (typeof value !== 'string' || !value || value.startsWith('/') || /[?#\\]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /%/i.test(value)) throw failure('离线资源路径无效');
    const url = new URL(value,scope);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) throw failure('离线资源必须来自本站');
    return url.href;
  };
  async function validateManifest(value) {
    if (!value || value.schema !== 1 || value.version !== environment.build || value.workerHash !== environment.workerHash || !Array.isArray(value.assets) || value.assets.length < 2 || value.assets.length > 1000) throw failure('离线清单版本不匹配，请稍后重试');
    const seen = new Set();
    let size = 0;
    const assets = value.assets.map(item => {
      const url = assetURL(item.url);
      if (seen.has(url) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 128*1024*1024 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw failure('离线资源清单不完整');
      seen.add(url);size += item.bytes;
      return {url:item.url,bytes:item.bytes,sha256:item.sha256};
    });
    if (!assets.some(item=>item.url==='index.html') || !assets.some(item=>item.url==='offline.mjs') || size !== value.totalBytes || value.totalFiles !== assets.length || size > 512*1024*1024) throw failure('离线资源总量不匹配');
    const actual = await digest(new TextEncoder().encode(JSON.stringify({schema:1,assets,workerHash:environment.workerHash})));
    if (actual !== environment.build) throw failure('离线清单校验失败');
    return {...value,assets};
  }
  async function verifiedResponse(url, expected) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),90000);
    try {
      const response = await environment.fetch(url,{cache:'no-store',credentials:'same-origin',redirect:'error',signal:controller.signal});
      if (!response || response.status !== 200 || response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect' || (response.url && response.url !== url)) throw failure('资源下载失败或发生重定向');
      const data = await response.arrayBuffer();
      if (expected && (data.byteLength !== expected.bytes || await digest(data) !== expected.sha256)) throw failure(`资源校验失败：${expected.url}`);
      return {response:new Response(data,{status:200,headers:response.headers}),data};
    } finally { clearTimeout(timer); }
  }
  async function cachedState() {
    if (!(await environment.caches.keys()).includes(cacheName)) return null;
    const cache = await environment.caches.open(cacheName);
    const marker = await cache.match(readyURL);
    const stored = await cache.match(manifestURL);
    if (!marker || !stored) return null;
    try {
      const manifest = await validateManifest(await stored.json());
      const ready = await marker.json();
      if (ready.version !== manifest.version || ready.files !== manifest.totalFiles) return null;
      for (const item of manifest.assets) if (!(await cache.match(assetURL(item.url)))) return null;
      return manifest;
    } catch {return null;}
  }
  async function status() {
    if (pending) return {...progress};
    const manifest = await cachedState();
    if (manifest) return {...progress,state:'ready',ready:true,completed:manifest.totalFiles,total:manifest.totalFiles,bytes:manifest.totalBytes,totalBytes:manifest.totalBytes,message:'页面与模型已完整缓存，可断网使用'};
    return {...progress,state:'incomplete',ready:false,message:'离线资源尚未备齐或已被清理，请联网重新准备'};
  }
  function prepare({repair=false}={}) {
    if (pending) return pending;
    pending = (async()=>{
      const complete = await cachedState();
      if (complete) return publish({state:'ready',ready:true,completed:complete.totalFiles,total:complete.totalFiles,bytes:complete.totalBytes,totalBytes:complete.totalBytes,message:'页面与模型已完整缓存，可断网使用'});
      if (!repair) await environment.caches.delete(cacheName);
      const cache = await environment.caches.open(cacheName);
      await cache.delete(readyURL);
      await publish({state:'downloading',ready:false,completed:0,total:0,bytes:0,totalBytes:0,message:'正在读取离线资源清单'});
      try {
        const downloaded = await verifiedResponse(manifestURL);
        const manifest = await validateManifest(JSON.parse(new TextDecoder().decode(downloaded.data)));
        await publish({total:manifest.totalFiles,totalBytes:manifest.totalBytes,message:'正在下载并校验页面和模型'});
        for (const item of manifest.assets) {
          const url = assetURL(item.url);
          const response = await verifiedResponse(url,item);
          await cache.put(url,response.response);
          await publish({completed:progress.completed+1,bytes:progress.bytes+item.bytes,message:`正在准备离线资源 ${progress.completed+1}/${manifest.totalFiles}`});
        }
        await cache.put(manifestURL,new Response(JSON.stringify(manifest),{headers:{'Content-Type':'application/json'}}));
        await cache.put(readyURL,new Response(JSON.stringify({schema:1,version:manifest.version,files:manifest.totalFiles}),{headers:{'Content-Type':'application/json'}}));
        if (!(await cachedState())) throw failure('缓存写入未完成，请重试');
        return publish({state:'ready',ready:true,message:'页面与模型已完整缓存，可断网使用'});
      } catch (error) {
        await cache.delete(readyURL).catch(()=>{});
        if (!repair) await environment.caches.delete(cacheName).catch(()=>{});
        await publish({state:'error',ready:false,message:`离线准备失败：${error?.name === 'QuotaExceededError' ? '设备存储空间不足' : error?.name === 'AbortError' ? '下载超时，请重试' : error?.message || '请检查网络后重试'}。旧离线版本不会被删除。`});
        throw error;
      }
    })().finally(()=>{pending=null;});
    return pending;
  }
  async function activate() {
    if (!(await cachedState())) throw failure('完整离线资源不可用，取消启用');
    // This only runs after the previous worker has no controlled pages. No skipWaiting.
    for (const name of await environment.caches.keys()) if (name.startsWith(prefix) && name !== cacheName) await environment.caches.delete(name);
    await environment.claim?.();
    await publish({...await status(),message:'页面与模型已完整缓存，可断网使用'});
  }
  async function respond(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return new Response('Offline application: network request blocked.',{status:403});
    url.search='';url.hash='';
    if (url.pathname === scope.pathname) url.pathname += 'index.html';
    const cache = await environment.caches.open(cacheName);
    const response = await cache.match(url.href);
    if (response) return response;
    await publish({state:'incomplete',ready:false,message:'离线资源缺失，请联网重新准备；当前请求不会回退到网络'});
    return new Response('离线资源缺失，请联网重新准备。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
  return {prepare,status,activate,respond,validateManifest,cacheName,prefix};
}

if (typeof self !== 'undefined' && self.registration && self.clients) {
  const runtime = createOfflineRuntime({
    scope:self.registration.scope,build:OFFLINE_BUILD,workerHash:OFFLINE_WORKER_SOURCE_HASH,
    caches:self.caches,fetch:self.fetch.bind(self),crypto:self.crypto,
    broadcast:async value=>{
      for (const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})) {
        if (client.url.startsWith(self.registration.scope)) client.postMessage(value);
      }
    },
    claim:()=>self.clients.claim(),
  });
  self.addEventListener('install',event=>event.waitUntil(runtime.prepare()));
  self.addEventListener('activate',event=>event.waitUntil(runtime.activate()));
  self.addEventListener('fetch',event=>event.respondWith(runtime.respond(event.request)));
  self.addEventListener('message',event=>{
    if (event.data?.channel !== OFFLINE_CHANNEL || !event.source?.url?.startsWith(self.registration.scope)) return;
    const work = event.data.type === 'PREPARE' ? runtime.prepare({repair:true}) : event.data.type === 'STATUS' ? runtime.status() : null;
    if (!work) return;
    event.waitUntil(Promise.resolve(work).then(value=>event.ports[0]?.postMessage({channel:OFFLINE_CHANNEL,...value})).catch(async()=>event.ports[0]?.postMessage({channel:OFFLINE_CHANNEL,...await runtime.status(),state:'error'})));
  });
}
