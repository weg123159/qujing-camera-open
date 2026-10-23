import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoWorkbench} from '../dist/photo-workbench.mjs';

class Element extends EventTarget {
  constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.textContent='';this.value='';this.disabled=false;
    const classes=new Set();this.classList={toggle(name,value){if(value)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  querySelectorAll(){return this.children.filter(child=>child.tagName==='BUTTON'&&child.dataset.intent);}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
}
const ids=['lightBtn','lightChipText','styleBadge','styleQuickList','openStyleBtn','lightDialog','lightCondition','lightSummary',
  'lightMetrics','lightTips','lightParameterHints','intentControls','lightEVSuggestion','lightEVReason','applyExposureBtn',
  'exposureStatus','exposureControls','exposureSlider','exposureValue','resetExposureBtn','recommendedStyleName','recommendedStyleReason',
  'applyRecommendedStyleBtn','styleDialog','styleList','styleDescription','styleControlList','styleResetBtn','styleCurrentName','styleStatus'];
function fixture(t,{sourceMode='camera',paint=()=>128,exposure={supported:true,value:1,min:-2,max:2,step:.1,pending:false},setExposure}={}) {
  const saved={document:globalThis.document,performance:globalThis.performance,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
  let now=0;const timers=new Map(),draws=[],effects=[],analyses=[],toasts=[],requests=[],dialogs=[];
  const nodes=Object.fromEntries(ids.map(id=>[id,new Element(id.includes('Btn')?'button':'div')]));
  for(const intent of ['portrait','still','motion']){const button=new Element('button');button.dataset.intent=intent;nodes.intentControls.append(button);}
  const document=new Element();document.hidden=false;document.visibilityState='visible';document.getElementById=id=>nodes[id]||null;
  document.createElement=tag=>{
    const element=new Element(tag);if(tag!=='canvas')return element;
    let mirrored=false,draw=null;
    const context={filter:'none',setTransform(){mirrored=false;},clearRect(){},translate(){},scale(x){mirrored=x<0;},
      drawImage(media,sx,sy,sw,sh,dx,dy,width,height){draw={media,sx,sy,sw,sh,dx,dy,width,height,mirrored,filter:this.filter};draws.push(draw);},
      getImageData(x,y,width,height){
        const data=new Uint8ClampedArray(width*height*4);
        for(let py=0;py<height;py++)for(let px=0;px<width;px++) {
          const sx=draw.sx+((draw.mirrored?width-1-px:px)+.5)/width*draw.sw,sy=draw.sy+(py+.5)/height*draw.sh;
          const value=draw.media.paint(sx,sy);data.set(Array.isArray(value)?value:[value,value,value,255],(py*width+px)*4);
        }return {data,width,height};
      }};
    element.getContext=()=>context;return element;
  };
  globalThis.document=document;globalThis.performance={now:()=>now};
  globalThis.setInterval=callback=>{const id=timers.size+1;timers.set(id,callback);return id;};globalThis.clearInterval=id=>timers.delete(id);
  const media={videoWidth:400,videoHeight:300,naturalWidth:400,naturalHeight:300,currentTime:1,paint};
  const context={sourceMode,sourceKey:'source:1',zoomRevision:0,media,crop:{sx:0,sy:0,sw:400,sh:300},
    mirrored:false,ready:true,controlsPending:false,zoomActive:false,subjectBox:null,frameTime:1};
  const api=createPhotoWorkbench({getContext:()=>context,getExposure:()=>exposure,
    setExposure:value=>{requests.push(value);return setExposure?setExposure(value):Promise.resolve(true);},
    onEffects:(settings,filter)=>effects.push({settings,filter}),onAnalysis:value=>analyses.push(value),toast:value=>toasts.push(value),
    openDialog:(dialog,trigger)=>dialogs.push({dialog,trigger})});
  t.after(()=>{api.dispose();for(const [key,value]of Object.entries(saved))globalThis[key]=value;});
  return {api,context,exposure,nodes,document,draws,effects,analyses,toasts,requests,dialogs,timers,
    advance(ms,{frame}={}){now+=ms;if(frame!==undefined)context.frameTime=frame;for(const tick of [...timers.values()])tick();}};
}
const settle=async()=>{await Promise.resolve();await Promise.resolve();};

test('static analysis uses the exact raw crop and mirror, and never enables camera EV',t=>{
  const f=fixture(t,{sourceMode:'image',paint:x=>x<160?20:210});
  f.context.crop={sx:100,sy:20,sw:120,sh:180};f.context.mirrored=true;f.api.start();
  const pixels=f.api.getBackground(),analysis=f.api.getAnalysis(),draw=f.draws[0];
  assert.equal(pixels.width,160);assert.equal(pixels.height,240);assert.equal(pixels.sourceKey,'source:1');
  assert.equal(pixels.pixels[0],210);assert.equal(pixels.pixels[(160-1)*4],20);
  assert.deepEqual([draw.sx,draw.sy,draw.sw,draw.sh,draw.mirrored,draw.filter],[100,20,120,180,true,'none']);
  assert.equal(analysis.stable,true);assert.equal(analysis.sourceMode,'image');assert.equal(f.draws.length,1);
  assert.deepEqual(f.nodes.lightMetrics.children.map(card=>card.children.map(child=>child.tagName)),[['SMALL','STRONG'],['SMALL','STRONG'],['SMALL','STRONG']]);
  assert.match(f.nodes.lightSummary.textContent,/没有可靠人物区域/);
  assert.equal(f.nodes.applyExposureBtn.disabled,true);assert.equal(f.nodes.exposureControls.hidden,true);
  f.advance(500);assert.equal(f.draws.length,1);
  ++f.context.zoomRevision;assert.equal(f.api.getBackground(),null);assert.equal(f.api.getAnalysis(),null);
  f.advance(500);assert.equal(f.api.getBackground().zoomRevision,1);
  const [portrait,,motion]=f.nodes.intentControls.children;motion.click();
  assert.equal(portrait.classList.contains('selected'),false);assert.equal(motion.classList.contains('selected'),true);
  assert.equal(f.api.getAnalysis().intent,'motion');
  f.context.controlsPending=true;assert.equal(f.api.getBackground(),null);assert.equal(f.api.getAnalysis(),null);
});

test('live stability counts distinct video frames and expired or moving views cannot retain pixels',t=>{
  const f=fixture(t);f.api.start();assert.equal(f.api.getAnalysis().stable,false);
  f.advance(500);assert.equal(f.api.getAnalysis().stable,false);assert.equal(f.draws.length,1);
  f.advance(500,{frame:2});assert.equal(f.api.getAnalysis().stable,true);assert.equal(f.draws.length,2);
  f.advance(1900);assert.equal(f.api.getAnalysis(),null);assert.equal(f.api.getBackground(),null);
  f.advance(500,{frame:3});assert.equal(f.api.getAnalysis().stable,false);
  f.context.zoomActive=true;assert.equal(f.api.getBackground(),null);assert.equal(f.api.getAnalysis(),null);
  f.context.zoomActive=false;f.advance(500);assert.equal(f.api.getAnalysis(),null);
  f.advance(500,{frame:4});assert.equal(f.api.getAnalysis().stable,false);
});

test('EV recommendation starts from actual device EV, clears evidence while pending and displays readback',async t=>{
  let finish;const f=fixture(t,{paint:()=>250,setExposure:value=>new Promise(resolve=>{finish=()=>{f.exposure.value=value;resolve(true);};})});
  f.api.start();f.advance(500,{frame:2});assert.equal(f.nodes.applyExposureBtn.disabled,false);
  f.nodes.applyExposureBtn.click();assert.ok(Math.abs(f.requests[0]-.3)<1e-8);
  assert.equal(f.api.getAnalysis(),null);assert.equal(f.api.getBackground(),null);assert.equal(f.nodes.applyExposureBtn.disabled,true);
  f.nodes.applyExposureBtn.dispatchEvent(new Event('click'));assert.equal(f.requests.length,1);
  finish();await settle();assert.match(f.nodes.exposureValue.textContent,/\+0\.3 EV/);
  f.advance(500);assert.equal(f.api.getAnalysis(),null);
  f.advance(500,{frame:3});assert.equal(f.api.getAnalysis().stable,false);
  f.advance(500,{frame:4});assert.equal(f.api.getAnalysis().stable,true);
  f.exposure.supported=false;f.api.refreshExposure();assert.equal(f.nodes.applyExposureBtn.disabled,true);
  f.nodes.applyExposureBtn.dispatchEvent(new Event('click'));assert.equal(f.requests.length,1);
  assert.match(f.nodes.exposureStatus.textContent,/未.*开放|没有开放/);
});

test('completion of an old exposure request cannot announce or replace a new source',async t=>{
  let finish;const f=fixture(t,{paint:()=>250,setExposure:()=>new Promise(resolve=>{finish=resolve;})});
  f.api.start();f.advance(500,{frame:2});f.nodes.applyExposureBtn.click();
  f.context.sourceKey='source:2';f.context.sourceMode='image';f.context.media={...f.context.media,paint:()=>100};f.exposure.value=-1;
  assert.equal(f.api.getAnalysis(),null);assert.equal(f.api.getBackground(),null);
  finish(true);await settle();
  assert.equal(f.toasts.length,0);assert.equal(f.api.getAnalysis().sourceKey,'source:2');
  assert.equal(f.api.getBackground().sourceKey,'source:2');assert.equal(f.exposure.value,-1);
});

test('a slider draft belongs to its original camera and is cancelled when the source changes',t=>{
  const f=fixture(t);f.api.start();
  f.nodes.exposureSlider.value='1.5';f.nodes.exposureSlider.dispatchEvent(new Event('input'));
  f.context.sourceKey='camera:2';f.context.media={...f.context.media};
  f.nodes.exposureSlider.dispatchEvent(new Event('change'));
  assert.equal(f.requests.length,0);assert.equal(Number(f.nodes.exposureSlider.value),f.exposure.value);
  f.nodes.exposureSlider.value='.5';f.nodes.exposureSlider.dispatchEvent(new Event('input'));
  f.context.controlsPending=true;f.api.invalidate();f.context.controlsPending=false;
  f.nodes.exposureSlider.dispatchEvent(new Event('change'));assert.equal(f.requests.length,0);
});

test('style DOM is retained, manual edits survive analysis, and recommendations require a click',t=>{
  const f=fixture(t,{sourceMode:'image'});f.api.start();
  const buttons=[...f.nodes.styleQuickList.children],inputs=[...f.nodes.styleControlList.children];
  buttons.find(button=>button.dataset.style==='film').click();
  const brightness=inputs[0].children[1];brightness.value='17';brightness.dispatchEvent(new Event('input'));
  const manual=f.api.getStyleSnapshot();assert.equal(manual.settings.brightness,17);assert.equal(manual.settings.id,'film');
  f.context.media.paint=()=>250;f.context.sourceKey='source:2';f.advance(500);
  assert.deepEqual(f.api.getStyleSnapshot(),manual);assert.equal(f.nodes.recommendedStyleName.textContent,'原色');
  assert.deepEqual(f.nodes.styleQuickList.children,buttons);assert.deepEqual(f.nodes.styleControlList.children,inputs);
  f.nodes.applyRecommendedStyleBtn.click();assert.equal(f.api.getStyleSnapshot().filter,'none');assert.equal(f.effects.length,4);
  f.nodes.styleBadge.click();assert.equal(f.dialogs.at(-1).dialog,f.nodes.styleDialog);assert.equal(f.dialogs.at(-1).trigger,f.nodes.styleBadge);
});

test('visibility and disposal revoke analysis immediately and release events and timers',t=>{
  const f=fixture(t);f.api.start();f.advance(500,{frame:2});assert.equal(f.api.getAnalysis().stable,true);
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.api.getAnalysis(),null);assert.equal(f.api.getBackground(),null);assert.equal(f.analyses.at(-1),null);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.api.getAnalysis(),null);f.advance(500,{frame:3});assert.equal(f.api.getAnalysis().stable,false);
  const count=f.effects.length;f.api.dispose();assert.equal(f.timers.size,0);assert.equal(f.api.start(),false);
  f.nodes.styleQuickList.children[1].click();assert.equal(f.effects.length,count);
  assert.equal(f.api.getAnalysis(),null);assert.equal(f.api.getBackground(),null);
});
