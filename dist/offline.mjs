const CHANNEL='qujing-offline';

/** Native callers may pass bundled=true only after verifying their local APK bridge. */
export function createOfflineManager({onStatus=()=>{},bundled=false,navigatorObject=globalThis.navigator,secureContext=globalThis.isSecureContext,baseURL=new URL('./',import.meta.url).href,MessageChannelClass=globalThis.MessageChannel}={}) {
  const base=new URL(baseURL);
  const workerURL=new URL('sw.js',base).href;
  let registration=null,started=false,disposed=false,pending=null;
  let state={state:'idle',ready:false,completed:0,total:0,bytes:0,totalBytes:0,version:null,persistent:false,message:'尚未准备网页离线资源'};
  const listeners=new Set();
  const emit=values=>{state={...state,...values};if(!disposed)onStatus({...state});return {...state};};
  const supported=()=>Boolean(secureContext&&navigatorObject?.serviceWorker&&MessageChannelClass);
  const isOwn=worker=>worker?.scriptURL===workerURL;
  const onMessage=event=>{
    if(event.data?.channel!==CHANNEL || !isOwn(event.source)) return;
    const waiting=registration?.waiting===event.source || (event.source!==navigatorObject.serviceWorker.controller && registration?.active && event.data.state==='ready');
    emit({...event.data,...(waiting&&event.data.ready?{state:'update-ready',message:'新版离线资源已备齐；关闭所有取景窗口后重新打开即可启用'}:{})});
  };
  function request(worker,type,timeout=12000) {
    return new Promise((resolve,reject)=>{
      if(!isOwn(worker)) return reject(new Error('未找到当前应用的离线服务'));
      const channel=new MessageChannelClass();
      let finished=false;
      const finish=(value,error)=>{
        if(finished)return;finished=true;clearTimeout(timer);channel.port1.close();channel.port2.close();listeners.delete(cleanup);
        error?reject(error):resolve(value);
      };
      const cleanup=()=>finish(null,new Error('页面已关闭'));
      const timer=setTimeout(()=>finish(null,new Error('离线服务未响应，请重试')),timeout);
      listeners.add(cleanup);
      channel.port1.onmessage=event=>{
        if(event.data?.channel!==CHANNEL) return;
        finish(event.data);
      };
      try {worker.postMessage({channel:CHANNEL,type},[channel.port2]);}
      catch(error){finish(null,error);}
    });
  }
  function waitForWorker(worker,waitingAllowed) {
    return new Promise((resolve,reject)=>{
      if(!worker) return resolve();
      let timer;
      const finish=error=>{clearTimeout(timer);worker.removeEventListener('statechange',check);listeners.delete(cleanup);error?reject(error):resolve();};
      const check=()=>{
        if((worker.state==='installed'&&waitingAllowed)||worker.state==='activated') finish();
        else if(worker.state==='redundant') finish(new Error('离线资源未完整安装，请检查网络或存储后重试'));
      };
      const cleanup=()=>finish(new Error('页面已关闭，离线准备可在下次继续'));
      listeners.add(cleanup);worker.addEventListener('statechange',check);
      timer=setTimeout(()=>finish(new Error('离线资源准备超时，请重试')),15*60*1000);
      check();
    });
  }
  async function persisted() {
    try{return Boolean(await navigatorObject?.storage?.persisted?.());}catch{return false;}
  }
  async function check() {
    if(bundled) return emit({state:'bundled',ready:true,persistent:true,message:'页面和模型已随安装包内置；应用未申请联网权限'});
    if(!supported()) return emit({state:'unsupported',ready:false,message:'当前环境不支持网页离线缓存；请使用 HTTPS 独立页面或 Android 离线版'});
    try {
      registration=await navigatorObject.serviceWorker.getRegistration(base.href);
      const worker=isOwn(registration?.waiting)?registration.waiting:isOwn(registration?.active)?registration.active:null;
      if(!worker) return emit({state:'idle',ready:false,persistent:await persisted(),message:'尚未准备网页离线资源，请联网完成一次准备'});
      const status=await request(worker,'STATUS');
      return emit({...status,persistent:await persisted(),...(registration.waiting===worker&&status.ready?{state:'update-ready',message:'新版离线资源已备齐；关闭所有取景窗口后重新打开即可启用'}:{})});
    }catch(error){return emit({state:'error',ready:false,message:`无法检查离线资源：${error.message}`});}
  }
  async function start() {
    if(disposed) return {...state};
    if(!started){started=true;if(!bundled&&supported())navigatorObject.serviceWorker.addEventListener('message',onMessage);}
    return check();
  }
  function prepare() {
    if(pending) return pending;
    if(disposed) return Promise.resolve({...state});
    pending=(async()=>{
      await start();
      if(bundled||!supported())return {...state};
      const priorReady=state.ready;
      emit({state:'downloading',completed:0,total:0,bytes:0,message:'正在准备完整离线资源，请保持页面打开'});
      try {
        let persistent=state.persistent;
        try{persistent=Boolean(await navigatorObject.storage?.persist?.());}catch{}
        emit({persistent});
        registration=await navigatorObject.serviceWorker.register(workerURL,{scope:base.href,updateViaCache:'none'});
        // Explicit user preparation also checks updates. Running pages are never forcibly reloaded.
        if(!registration.installing) await registration.update();
        if(registration.installing) await waitForWorker(registration.installing,Boolean(registration.active));
        const worker=isOwn(registration.waiting)?registration.waiting:registration.active;
        if(!worker) throw new Error('离线服务尚未启用，请重试');
        let result=await request(worker,'STATUS');
        if(!result.ready)result=await request(worker,'PREPARE',15*60*1000);
        return emit({...result,persistent,...(registration.waiting===worker&&result.ready?{state:'update-ready',message:'新版离线资源已备齐；关闭所有取景窗口后重新打开即可启用'}:{})});
      }catch(error){return emit({state:'error',ready:priorReady,message:`离线准备未完成：${error.message}${priorReady?'。已有完整离线版本仍保留':''}`});}
    })().finally(()=>{pending=null;});
    return pending;
  }
  function dispose(){disposed=true;navigatorObject?.serviceWorker?.removeEventListener?.('message',onMessage);for(const cleanup of listeners)cleanup();listeners.clear();}
  return {start,prepare,check,getStatus:()=>({...state}),dispose};
}
