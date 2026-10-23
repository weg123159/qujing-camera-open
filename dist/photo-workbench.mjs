import {analyzeScene,createSceneStabilizer} from './scene-analysis.mjs';
import {STYLE_PRESETS,STYLE_CONTROLS,createStyleSettings,normalizeStyleSettings,styleFilter,recommendStyle} from './photo-style.mjs';

const SAMPLE_INTERVAL=500,MAX_AGE=1800;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const evText=value=>`${value>0?'+':''}${Number(value.toFixed(2))} EV`;
const percent=value=>`${Math.round(value*100)}%`;
const keyOf=value=>typeof value==='string'||typeof value==='number'?String(value):null;
const fingerprint=context=>JSON.stringify([context.sourceMode,keyOf(context.sourceKey),context.zoomRevision,
  Boolean(context.mirrored),...['sx','sy','sw','sh'].map(key=>context.crop?.[key])]);
const boxKey=box=>JSON.stringify(box?['x','y','width','height','kind','visible'].map(key=>box[key]):null);
const clock=()=>performance.now();
const noExposure=()=>({supported:false,value:null,pending:false,reason:'not_available'});
const validExposure=value=>Boolean(value?.supported)&&[value.value,value.min,value.max].every(Number.isFinite)
  &&value.max>value.min&&value.value>=value.min&&value.value<=value.max;
const snapExposure=(value,range)=>{
  const limited=clamp(value,range.min,range.max);
  return clamp(range.step>0?range.min+Math.round((limited-range.min)/range.step)*range.step:limited,range.min,range.max);
};

/**
 * Mobile light/style controller. Analysis always reads the unstyled media.
 * getAnalysis() returns analysis + {stable,sourceMode,zoomRevision}, or null;
 * onAnalysis receives the same read-only value. Static stability means this
 * photograph is available; only a stable, current CAMERA frame can apply an EV
 * recommendation. Background pixels are read-only and have the visible crop.
 * Host must call invalidate() when starting a gesture or changing source/crop;
 * every public read also checks source, pending controls, visibility and age.
 */
export function createPhotoWorkbench({getContext,getExposure=noExposure,setExposure=async()=>false,
  openDialog=()=>{},onEffects=()=>{},onAnalysis=()=>{},toast=()=>{}}={}) {
  if(typeof getContext!=='function')throw new TypeError('getContext is required');
  const $=id=>document.getElementById(id),nodes={};
  for(const id of ['lightBtn','lightChipText','styleBadge','styleQuickList','openStyleBtn','lightDialog','lightCondition',
    'lightSummary','lightMetrics','lightTips','lightParameterHints','intentControls','lightEVSuggestion','lightEVReason',
    'applyExposureBtn','exposureStatus','exposureControls','exposureSlider','exposureValue','resetExposureBtn',
    'recommendedStyleName','recommendedStyleReason','applyRecommendedStyleBtn','styleDialog','styleList','styleDescription',
    'styleControlList','styleResetBtn','styleCurrentName','styleStatus'])nodes[id]=$(id);
  const surface=document.createElement('canvas');
  const drawing=surface.getContext('2d',{willReadFrequently:true});
  const guard=createSceneStabilizer({maxAgeMs:MAX_AGE});
  const listeners=[],styleButtons=[],styleInputs=[];
  let settings=createStyleSettings(),intent='portrait',running=false,disposed=false,timer=null;
  let signature=null,media=null,latest=null,background=null,lastSampleAt=-Infinity,lastFrame=null,lastBox=null;
  let status='waiting',pendingExposure=false,exposureEdit=false,exposureEditOrigin=null,exposureError='',requestId=0;
  let recommendation=recommendStyle(null),hasEmittedStyle=false;
  const text=(node,value)=>{if(node&&node.textContent!==value)node.textContent=value;};
  const listen=(node,event,handler)=>{if(node){node.addEventListener(event,handler);listeners.push(()=>node.removeEventListener(event,handler));}};
  const readContext=()=>{try{return getContext()||{};}catch{return {};}};
  const readExposure=()=>{try{return getExposure()||noExposure();}catch{return noExposure();}};
  const frameTime=context=>Number.isFinite(context.frameTime)?context.frameTime:context.media?.currentTime;
  const hidden=()=>document.hidden||document.visibilityState==='hidden';
  function blockedReason(context) {
    if(disposed)return 'disposed';
    if(hidden())return 'hidden';
    if(context.zoomActive)return 'zoom';
    if(context.controlsPending||pendingExposure||(context.sourceMode==='camera'&&readExposure().pending))return 'controls';
    const crop=context.crop;
    if(!drawing||!context.ready||!context.media||!crop||!['sx','sy','sw','sh'].every(key=>Number.isFinite(crop[key]))
      ||crop.sx<0||crop.sy<0||crop.sw<=0||crop.sh<=0||crop.sh/crop.sw>10)return 'waiting';
    const width=context.media.videoWidth||context.media.naturalWidth||context.media.width;
    const height=context.media.videoHeight||context.media.naturalHeight||context.media.height;
    if(width>0&&height>0&&(crop.sx+crop.sw>width+.01||crop.sy+crop.sh>height+.01))return 'waiting';
    if(context.sourceMode==='camera'&&!Number.isFinite(frameTime(context)))return 'frame';
    return null;
  }
  function publish(analysis,stable,context,reason) {
    status=reason;
    latest=analysis?{...analysis,stable,sourceMode:context.sourceMode,zoomRevision:context.zoomRevision}:null;
    renderAnalysis();
    onAnalysis(latest);
  }
  function clear(context,reason,{blockFrame=false}={}) {
    const changed=Boolean(latest||background)||status!==reason;
    if(exposureEditOrigin)exposureEditOrigin.cancelled=true;
    signature=fingerprint(context);media=context.media;guard.reset(context.sourceKey);
    latest=null;background=null;lastBox=null;lastSampleAt=-Infinity;status=reason;
    lastFrame=blockFrame&&context.sourceMode==='camera'?frameTime(context):null;
    if(changed){renderAnalysis();onAnalysis(null);}
  }
  function reconcile(now=clock()) {
    const context=readContext(),next=fingerprint(context);
    if(next!==signature||context.media!==media){exposureEdit=false;exposureError='';clear(context,'waiting');}
    const blocked=blockedReason(context);
    if(blocked){clear(context,blocked,{blockFrame:true});return {context,valid:false};}
    if(context.sourceMode==='camera'&&background&&now-lastSampleAt>MAX_AGE)clear(context,'expired',{blockFrame:true});
    return {context,valid:true};
  }
  function sample(context,now) {
    const live=context.sourceMode==='camera',time=frameTime(context),subject=boxKey(context.subjectBox);
    if(now-lastSampleAt<SAMPLE_INTERVAL)return;
    if(live&&time===lastFrame)return;
    if(live&&lastFrame!==null&&time<lastFrame){clear(context,'frame',{blockFrame:true});return;}
    if(!live&&background&&subject===lastBox)return;
    try {
      let pixels=background?.pixels,width=background?.width,height=background?.height;
      if(live||!background) {
        width=160;height=Math.max(2,Math.round(width*context.crop.sh/context.crop.sw));
        surface.width=width;surface.height=height;
        drawing.setTransform(1,0,0,1,0,0);drawing.filter='none';drawing.clearRect(0,0,width,height);
        if(context.mirrored){drawing.translate(width,0);drawing.scale(-1,1);}
        const {sx,sy,sw,sh}=context.crop;
        drawing.drawImage(context.media,sx,sy,sw,sh,0,0,width,height);
        drawing.setTransform(1,0,0,1,0,0);
        pixels=drawing.getImageData(0,0,width,height).data;
      }
      const analysis=analyzeScene({pixels,width,height,subjectBox:context.subjectBox,sourceKey:context.sourceKey,intent});
      lastSampleAt=now;lastFrame=live?time:null;lastBox=subject;
      if(!analysis.ok){background=null;guard.reset(context.sourceKey);publish(null,false,context,'unreadable');return;}
      background={pixels,width,height,sourceKey:context.sourceKey,zoomRevision:context.zoomRevision};
      const result=live?guard.update(analysis,{now,observationId:time}):{analysis,stable:true};
      publish(result.analysis,result.stable,context,result.stable?'ready':'collecting');
    } catch {
      clear(context,'unreadable',{blockFrame:live});
      // Do not retry a failed canvas read on every lightweight poll.
      lastSampleAt=now;
    }
  }
  function tick() {
    if(disposed)return;
    const now=clock(),{context,valid}=reconcile(now);
    if(valid)sample(context,now);
    renderExposure(context);
  }
  function list(container,values,kind) {
    if(!container)return;
    container.replaceChildren(...values.map(value=>{
      const node=document.createElement(kind||(['UL','OL'].includes(container.tagName)?'li':'p'));
      node.textContent=value;return node;
    }));
  }
  function renderAnalysis() {
    const usable=latest?.stable;
    const waiting={waiting:'等待画面',hidden:'已暂停测光',zoom:'倍率调整中',controls:'相机参数调整中',
      frame:'等待新画面',expired:'等待新画面',unreadable:'暂无法读取画面',collecting:'正在确认光线',disposed:'测光已停止'};
    const label=usable?latest.condition.label:(waiting[status]||'正在确认光线');
    const metrics=usable?latest.metrics:null;
    const region=!metrics?'':metrics.subjectMean===null?'当前没有可靠人物区域，未进行人物区域测光。'
      :`人物区域亮度 ${percent(metrics.subjectMean)}${metrics.backgroundMean===null?'；没有可用背景区域，不作逆光比较。':`，背景 ${percent(metrics.backgroundMean)}。`} 区域亮度可能受衣服与背景影响。`;
    text(nodes.lightChipText,label);text(nodes.lightCondition,label);
    text(nodes.lightSummary,usable?`${latest.condition.message} ${region} 分析来自未加风格的取景画面。`
      :status==='unreadable'?'请重新打开相机或换一张本地图片。':status==='hidden'?'回到相机后会重新分析。':'画面与倍率稳定后，再根据实际像素给出建议。');
    if(nodes.lightMetrics)nodes.lightMetrics.replaceChildren(...(metrics?[
      ['平均亮度',metrics.mean],['高光比例',metrics.highlightRatio],['暗部比例',metrics.shadowRatio],
    ]:[]).map(([label,value])=>{
      const card=document.createElement('div'),caption=document.createElement('small'),number=document.createElement('strong');
      caption.textContent=label;number.textContent=percent(value);card.append(caption,number);return card;
    }));
    list(nodes.lightTips,usable?latest.recommendation.tips:[]);
    list(nodes.lightParameterHints,usable?latest.recommendation.parameterHints.map(hint=>`${hint.label}：${hint.value}。${hint.reason}`):[
      '这里分析的是相机处理后的像素，不能据此测出真实照度、色温或精确 ISO / 快门。',
    ]);
    recommendation=recommendStyle(usable?latest:null,intent);
    text(nodes.recommendedStyleName,STYLE_PRESETS.find(item=>item.id===recommendation.id)?.name||'原色');
    text(nodes.recommendedStyleReason,recommendation.reason);
    if(nodes.applyRecommendedStyleBtn)nodes.applyRecommendedStyleBtn.disabled=!usable;
    for(const button of nodes.intentControls?.querySelectorAll('button[data-intent]')||[]) {
      const selected=button.dataset.intent===intent;
      button.setAttribute('aria-pressed',String(selected));button.classList.toggle('selected',selected);
    }
  }
  function renderExposure(context=readContext()) {
    const exposure=readExposure(),live=context.sourceMode==='camera',supported=validExposure(exposure);
    const busy=pendingExposure||exposure.pending||context.controlsPending||context.zoomActive;
    const available=live&&supported&&!busy&&!hidden()&&Boolean(context.ready);
    if(nodes.exposureControls)nodes.exposureControls.hidden=!live||!supported;
    const messages={manual_exposure:'当前处于手动曝光模式，设备没有开放可用的自动曝光补偿。',
      unknown_exposure_mode:'设备没有提供可确认的自动曝光模式，不能可靠控制 EV。'};
    let description=!live?'照片分析可提供拍摄参考；导入的照片不能回溯修改相机曝光。':!supported
      ?messages[exposure.reason]||'当前摄像头没有开放可验证的 EV 控制。ISO、快门与白平衡仅提供参考。'
      :busy?'正在应用相机参数，确认后显示设备实际返回的 EV。':`设备实际曝光补偿 ${evText(exposure.value)}；范围 ${evText(exposure.min)} 至 ${evText(exposure.max)}。`;
    if(exposureError||exposure.error?.message)description+=` ${exposureError||exposure.error.message}`;
    text(nodes.exposureStatus,description);
    if(nodes.exposureSlider) {
      nodes.exposureSlider.disabled=!available;
      if(supported){nodes.exposureSlider.min=String(exposure.min);nodes.exposureSlider.max=String(exposure.max);nodes.exposureSlider.step=String(exposure.step>0?exposure.step:.1);
        if(!exposureEdit)nodes.exposureSlider.value=String(exposure.value);}
    }
    if(!exposureEdit)text(nodes.exposureValue,supported?evText(exposure.value):'不可用');
    if(nodes.resetExposureBtn)nodes.resetExposureBtn.disabled=!available||exposure.min>0||exposure.max<0||Math.abs(exposure.value)<.0001;
    const delta=latest?.recommendation?.ev?.delta;
    const stable=latest?.stable&&latest.sourceMode==='camera';
    const target=stable&&supported&&Number.isFinite(delta)?snapExposure(exposure.value+delta,exposure):null;
    const canApply=available&&stable&&target!==null&&Math.abs(target-exposure.value)>.0001;
    if(nodes.applyExposureBtn)nodes.applyExposureBtn.disabled=!canApply;
    text(nodes.lightEVSuggestion,!live?'照片明暗参考':!stable?'稳定画面后给出 EV 建议':delta===0?'建议先保持当前曝光':`建议相对当前 ${evText(delta)}`);
    text(nodes.lightEVReason,!live?'可在风格中调整画面明暗；画面调整不等于改变拍摄时的 ISO 或快门。'
      :!stable?'需要连续的新画面确认；倍率、曝光调节或画面失效期间不会应用旧建议。'
      :`${latest.recommendation.ev?.reason||''}${!supported?' 当前设备未开放 EV 控制。':delta!==0&&!canApply&&!busy?' 当前设备的步长或范围没有可应用的变化。':''}`);
  }
  function getStyleSnapshot() {
    return {settings:{...settings},filter:styleFilter(settings),name:STYLE_PRESETS.find(item=>item.id===settings.id)?.name||'原色'};
  }
  function renderStyle() {
    const snapshot=getStyleSnapshot(),preset=STYLE_PRESETS.find(item=>item.id===settings.id);
    text(nodes.styleBadge,snapshot.name);text(nodes.styleCurrentName,snapshot.name);
    text(nodes.styleDescription,preset?.description||'');
    text(nodes.styleStatus,'调整会进入生成的照片；不改变设备 ISO、快门或白平衡。');
    for(const button of styleButtons)button.setAttribute('aria-pressed',String(button.dataset.style===settings.id));
    for(const {control,input,output} of styleInputs){input.value=String(settings[control.key]);text(output,`${settings[control.key]>0?'+':''}${settings[control.key]}%`);}
  }
  function chooseStyle(next) {
    if(disposed)return;
    settings=normalizeStyleSettings(next);renderStyle();
    const snapshot=getStyleSnapshot();hasEmittedStyle=true;onEffects(snapshot.settings,snapshot.filter);
  }
  function buildStyles() {
    for(const container of [nodes.styleQuickList,nodes.styleList])if(container) {
      const buttons=STYLE_PRESETS.map(preset=>{
        const button=document.createElement('button');button.type='button';button.className='style-option';
        button.dataset.style=preset.id;button.textContent=preset.name;button.title=preset.description;
        listen(button,'click',()=>chooseStyle(createStyleSettings(preset.id)));styleButtons.push(button);return button;
      });container.replaceChildren(...buttons);
    }
    if(nodes.styleControlList)nodes.styleControlList.replaceChildren(...STYLE_CONTROLS.map(control=>{
      const row=document.createElement('label'),head=document.createElement('span'),label=document.createElement('span');
      const input=document.createElement('input'),output=document.createElement('output');
      row.className='style-control';head.className='style-control-head';label.textContent=control.label;
      input.type='range';input.min=String(control.min);input.max=String(control.max);input.step=String(control.step);
      input.dataset.styleControl=control.key;input.setAttribute('aria-label',control.label);
      listen(input,'input',()=>chooseStyle({...settings,[control.key]:Number(input.value)}));
      head.append(label,output);row.append(head,input);styleInputs.push({control,input,output});return row;
    }));
  }
  async function requestExposure(value,{recommended=false}={}) {
    const {context,valid}=reconcile(),exposure=readExposure();
    if(!valid||context.sourceMode!=='camera'||!validExposure(exposure)||exposure.pending||pendingExposure)return false;
    if(recommended&&(!latest?.stable||latest.sourceMode!=='camera'))return false;
    if(!Number.isFinite(value))return false;
    const next=snapExposure(value,exposure);
    if(Math.abs(next-exposure.value)<.0001)return false;
    const request=++requestId,origin=fingerprint(context),originMedia=context.media;
    pendingExposure=true;exposureEdit=false;exposureError='';
    clear(context,'controls',{blockFrame:true});renderExposure(context);
    let success=false;
    try{success=await setExposure(next);}catch{exposureError='设备暂时无法应用曝光，请稍后重试。';}
    if(disposed||request!==requestId)return false;
    pendingExposure=false;
    const current=readContext();
    if(origin!==fingerprint(current)||originMedia!==current.media){exposureError='';tick();return false;}
    const actual=readExposure();
    if(!success||!validExposure(actual)) {
      exposureError=exposureError||actual.error?.message||'设备没有确认这次曝光调整，保留实际读回值。';toast(exposureError);
    } else {exposureError='';toast(`曝光补偿已调整为 ${evText(actual.value)}`);}
    clear(current,'collecting',{blockFrame:true});renderExposure(current);
    return Boolean(success)&&validExposure(actual);
  }
  function invalidate(reason='waiting') {
    if(disposed)return;
    const context=readContext();clear(context,reason,{blockFrame:true});renderExposure(context);
  }
  function refreshExposure() {if(!disposed){const {context}=reconcile();renderExposure(context);}}
  function getAnalysis() {if(disposed)return null;reconcile();return latest;}
  function getBackground() {if(disposed)return null;reconcile();return background;}
  function openLight(trigger=nodes.lightBtn) {if(disposed)return;tick();openDialog(nodes.lightDialog,trigger);}
  function openStyle(trigger=nodes.openStyleBtn) {if(disposed)return;renderStyle();openDialog(nodes.styleDialog,trigger);}

  buildStyles();renderStyle();renderAnalysis();
  listen(nodes.lightBtn,'click',()=>openLight(nodes.lightBtn));
  listen(nodes.styleBadge,'click',()=>openStyle(nodes.styleBadge));
  listen(nodes.openStyleBtn,'click',()=>openStyle(nodes.openStyleBtn));
  listen(nodes.styleResetBtn,'click',()=>chooseStyle(createStyleSettings(settings.id)));
  listen(nodes.applyRecommendedStyleBtn,'click',()=>{
    const current=getAnalysis();if(current?.stable)chooseStyle(createStyleSettings(recommendStyle(current,intent).id));
  });
  for(const button of nodes.intentControls?.querySelectorAll('button[data-intent]')||[])listen(button,'click',()=>{
    const next=button.dataset.intent;if(!['portrait','still','motion'].includes(next)||next===intent)return;
    intent=next;invalidate('collecting');tick();
  });
  listen(nodes.applyExposureBtn,'click',()=>{
    const analysis=getAnalysis(),actual=readExposure();
    if(analysis?.stable&&analysis.sourceMode==='camera'&&validExposure(actual))
      void requestExposure(actual.value+analysis.recommendation.ev.delta,{recommended:true});
  });
  listen(nodes.resetExposureBtn,'click',()=>{const actual=readExposure();if(validExposure(actual)&&actual.min<=0&&actual.max>=0)void requestExposure(0);});
  listen(nodes.exposureSlider,'input',()=>{
    const context=readContext();
    if(!exposureEditOrigin)exposureEditOrigin={signature:fingerprint(context),media:context.media,cancelled:false};
    exposureEdit=true;text(nodes.exposureValue,`${evText(Number(nodes.exposureSlider.value))} · 松手应用`);
  });
  listen(nodes.exposureSlider,'change',()=>{
    const value=Number(nodes.exposureSlider.value),{context,valid}=reconcile(),origin=exposureEditOrigin;
    exposureEdit=false;exposureEditOrigin=null;
    if(valid&&origin&&!origin.cancelled&&origin.signature===fingerprint(context)&&origin.media===context.media)void requestExposure(value);
    refreshExposure();
  });
  listen(nodes.exposureSlider,'blur',()=>{exposureEdit=false;exposureEditOrigin=null;refreshExposure();});
  listen(nodes.exposureSlider,'pointercancel',()=>{exposureEdit=false;exposureEditOrigin=null;refreshExposure();});
  listen(document,'visibilitychange',()=>{if(hidden())invalidate('hidden');else if(running){invalidate('collecting');tick();}});

  const api={
    start(){if(disposed)return false;if(running)return true;running=true;
      if(!hasEmittedStyle){const snapshot=getStyleSnapshot();hasEmittedStyle=true;onEffects(snapshot.settings,snapshot.filter);}
      tick();timer=setInterval(tick,125);return true;},
    dispose(){if(disposed)return;disposed=true;running=false;++requestId;if(timer!==null)clearInterval(timer);timer=null;
      for(const remove of listeners)remove();clear(readContext(),'disposed');surface.width=surface.height=0;},
    invalidate,refreshExposure,openLight,openStyle,getBackground,getAnalysis,getStyleSnapshot,
  };
  return api;
}
