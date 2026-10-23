import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonDetector,normalizePersonDetections} from '../dist/person.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const prediction={class:'person',score:.75,bbox:[20,10,40,80]};

test('person anchor is bounding-box bottom center, not a face center',()=>{
 const frame=normalizePersonDetections([prediction],{width:100,height:100});
 assert.deepEqual(frame.point,{x:.4,y:.9});assert.equal(frame.kind,'person');assert.equal(frame.personCount,1);assert.equal(frame.faceCount,0);
});

test('largest accepted person is selected and non-person detections are excluded',()=>{
 const frame=normalizePersonDetections([prediction,{class:'dog',score:.99,bbox:[0,0,100,100]},{class:'person',score:.8,bbox:[40,20,20,30]}],{width:100,height:100});
 assert.equal(frame.personCount,2);assert.deepEqual(frame.box,{x:.2,y:.1,width:.4,height:.8});
});

test('sample-size normalization preserves original dimensions and raw mirror coordinates',()=>{
 const frame=normalizePersonDetections([prediction],{width:100,height:100,sourceWidth:2000,sourceHeight:2000,mirrored:true});
 assert.equal(frame.sourceWidth,2000);assert.equal(frame.sourceHeight,2000);assert.equal(frame.mirrored,true);assert.equal(frame.point.x,.4);
});

test('low confidence, malformed boxes and missing people produce no invented anchor',()=>{
 const frame=normalizePersonDetections([{...prediction,score:.1},{...prediction,bbox:[0,0,NaN,2]},{...prediction,bbox:[0,0,-2,3]}],{width:100,height:100});
 assert.equal(frame.personCount,0);assert.equal(frame.point,null);assert.equal(frame.box,null);
});

test('invalid dimensions cannot produce a framing score or location',()=>{
 const frame=normalizePersonDetections([prediction],{width:0,height:100});assert.equal(frame.point,null);assert.equal(frame.personCount,0);
});

function detector(){
 const d=new PersonDetector();
 d.execution='worker-cpu';d.load=async()=>({execution:'worker-cpu'});
 d._capture=()=>({pixels:new Uint8ClampedArray(4),width:100,height:100,sourceWidth:1000,sourceHeight:1000});
 return d;
}

test('person inference is serial even when photo calls arrive together',async()=>{
 const d=detector();let active=0,maxActive=0,calls=0;const finishes=[];
 d._request=()=>{calls++;active++;maxActive=Math.max(maxActive,active);return new Promise(resolve=>finishes.push(()=>{active--;resolve([prediction]);}));};
 const first=d.detect({});const second=d.detect({});await tick();assert.equal(calls,1);finishes.shift()();await first;await tick();assert.equal(calls,2);finishes.shift()();await second;
 assert.equal(maxActive,1);d.dispose();
});

test('invalidating in-flight and queued work prevents obsolete results',async()=>{
 const d=detector();let finish,calls=0;
 d._request=()=>{calls++;return new Promise(resolve=>finish=resolve);};
 const first=d.detect({});const second=d.detect({});
 const settled=Promise.allSettled([first,second]);await tick();d.invalidate();finish([prediction]);const results=await settled;
 assert.equal(calls,1);assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='Cancelled'));d.dispose();
});

test('no-person worker output remains an empty person result',async()=>{
 const d=detector();d._request=async()=>[];
 const frame=await d.detect({});assert.equal(frame.kind,'person');assert.equal(frame.point,null);assert.equal(frame.personCount,0);d.dispose();
});

test('dispose rejects pending worker operations and releases the worker',async()=>{
 const d=new PersonDetector();let terminated=0;
 d._worker={postMessage(){},terminate(){terminated++;}};
 const pending=d._request('detect');const settled=Promise.allSettled([pending]);d.dispose();const [result]=await settled;
 assert.equal(result.status,'rejected');assert.equal(result.reason.code,'Cancelled');assert.equal(terminated,1);assert.equal(d._pending.size,0);
});

test('all accepted candidates retain their actual confidence and unclamped crop evidence',()=>{
 const frame=normalizePersonDetections([
  {...prediction,bbox:[-10,-5,40,120]},
  {class:'person',score:.83,bbox:[60,20,20,50]},
  {class:'person',score:.39,bbox:[0,0,100,100]},
 ],{width:100,height:100,sourceWidth:2000,sourceHeight:2000});
 assert.equal(frame.candidates.length,2);assert.equal(frame.personCount,2);assert.equal(frame.confidence,.75);
 assert.deepEqual(frame.candidates.map(value=>value.confidence),[.75,.83]);
 assert.deepEqual(frame.box,{x:-.1,y:-.05,width:.4,height:1.2});
 assert.equal(frame.point.y,-.05+1.2);
});

test('genuine empty inference reports capture time and duration without fabricated confidence',async()=>{
 const d=detector();let sampledAt;
 d._capture=()=>{
  sampledAt=performance.now();return {pixels:new Uint8ClampedArray(4),width:100,height:100,sourceWidth:1000,sourceHeight:1000,capturedAtMs:sampledAt};
 };
 d._request=async()=>[];
 const frame=await d.detect({});
 assert.equal(frame.capturedAtMs,sampledAt);assert.ok(Number.isFinite(frame.inferenceDurationMs)&&frame.inferenceDurationMs>=0);
 assert.equal(frame.confidence,null);assert.deepEqual(frame.candidates,[]);assert.equal(frame.point,null);d.dispose();
});

test('caller cancellation removes queued work before another image is captured',async()=>{
 const d=detector();let finish,calls=0,captures=0,cancelled=false;
 const capture=d._capture;d._capture=media=>{captures++;return capture(media);};
 d._request=()=>{calls++;return new Promise(resolve=>finish=resolve);};
 const first=d.detect({});const second=d.detect({},{isCancelled:()=>cancelled});
 const settled=Promise.allSettled([first,second]);await tick();cancelled=true;finish([prediction]);
 const results=await settled;assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
 assert.equal(results[1].reason.code,'Cancelled');assert.equal(calls,1);assert.equal(captures,1);d.dispose();
});

test('caller cancellation drops an already-running result',async()=>{
 const d=detector();let finish,cancelled=false;
 d._request=()=>new Promise(resolve=>finish=resolve);
 const pending=d.detect({},{isCancelled:()=>cancelled});const settled=Promise.allSettled([pending]);
 await tick();cancelled=true;finish([prediction]);const [result]=await settled;
 assert.equal(result.status,'rejected');assert.equal(result.reason.code,'Cancelled');d.dispose();
});

test('capture reuses the canvas backing store and context for unchanged video dimensions',()=>{
 const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
 let width=0,height=0,widthSets=0,heightSets=0,contexts=0,draws=0;
 const context={drawImage(){draws++;},getImageData(){return {data:new Uint8ClampedArray(4)};}};
 const canvas={
  get width(){return width;},set width(value){width=value;widthSets++;},
  get height(){return height;},set height(value){height=value;heightSets++;},
  getContext(){contexts++;return context;},
 };
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>canvas}});
 const d=new PersonDetector();
 try{
  const first=d._capture({videoWidth:1920,videoHeight:1080});
  const second=d._capture({videoWidth:1920,videoHeight:1080});
  assert.deepEqual([first.width,first.height],[640,360]);assert.ok(Number.isFinite(first.capturedAtMs));
  assert.equal(second.sourceWidth,1920);assert.deepEqual([widthSets,heightSets,contexts,draws],[1,1,1,2]);
  d._capture({videoWidth:1920,videoHeight:1440});
  assert.deepEqual([width,height,widthSets,heightSets,contexts,draws],[640,480,1,2,1,3]);
 }finally{
  d.dispose();if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete globalThis.document;
 }
});
