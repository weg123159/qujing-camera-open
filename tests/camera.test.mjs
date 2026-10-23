import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraController,SubjectSelector} from '../dist/camera.mjs';

let rafID=0;
const rafs=new Map();
globalThis.requestAnimationFrame=(fn)=>{rafs.set(++rafID,fn);return rafID;};
globalThis.cancelAnimationFrame=(id)=>rafs.delete(id);
globalThis.isSecureContext=true;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setMedia(getUserMedia){Object.defineProperty(globalThis,'navigator',{value:{mediaDevices:{getUserMedia}},configurable:true});}
function stream(facing='environment'){
 const track=new EventTarget();
 track.stops=0;track.stop=()=>{track.stops++;};track.getSettings=()=>({facingMode:facing});
 return {track,getTracks:()=>[track],getVideoTracks:()=>[track]};
}
class Video extends EventTarget{
 constructor(){super();this.videoWidth=1920;this.videoHeight=1440;this.readyState=2;this.currentTime=1;this.srcObject=null;}
 play(){return Promise.resolve();}pause(){}setAttribute(){}
}
function controller(){
 const statuses=[],frames=[];
 const c=new CameraController({video:new Video(),onStatus:s=>statuses.push(s),onFrame:f=>frames.push(f)});
 const calls=[];
 c._loadDetector=async()=>({setOptions:async o=>calls.push(['mode',o.runningMode]),detect:()=>({detections:[]}),detectForVideo:()=>({detections:[]})});
 c._loadFallbackDetector=async()=>{throw new Error('CPU backend intentionally unavailable in this unit test');};
 return {c,statuses,frames,calls};
}

test('insecure origin refuses before requesting the camera',async()=>{
 let count=0;setMedia(()=>{count++;});globalThis.isSecureContext=false;
 const {c,statuses}=controller();assert.equal(await c.start(),false);assert.equal(count,0);assert.equal(statuses.at(-1).code,'InsecureContext');
 globalThis.isSecureContext=true;c.stop();
});
test('permission denial returns an actionable error and no detector load',async()=>{
 setMedia(async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});});
 const {c,statuses,frames}=controller();let loads=0;c._loadDetector=async()=>{loads++;};
 assert.equal(await c.start(),false);assert.equal(statuses.at(-1).code,'NotAllowedError');assert.equal(c.running,false);assert.equal(frames.length,0);assert.equal(loads,0);c.stop();
});
test('repeated start while permission is pending issues one media request',async()=>{
 let count=0,grant;setMedia(()=>{count++;return new Promise(r=>grant=r);});
 const {c,frames}=controller();const a=c.start();const b=c.start();assert.equal(count,1);
 grant(stream());assert.deepEqual(await Promise.all([a,b]),[true,true]);await tick();assert.equal(frames.length,1);assert.equal(c.running,true);c.stop();
});
test('stop resolves a pending start and closes a late-granted camera',async()=>{
 let grant;setMedia(()=>new Promise(r=>grant=r));
 const {c,statuses,frames}=controller();const pending=c.start();c.stop();
 assert.equal(await pending,false);const late=stream();grant(late);await tick();
 assert.equal(late.track.stops,1);assert.equal(frames.length,0);assert.equal(statuses.at(-1).state,'stopped');assert.equal(c.running,false);
});
test('switch releases old tracks and reports actual front-camera mirroring',async()=>{
 const rear=stream(),front=stream('user');let requests=0;
 setMedia(async()=>requests++ ? front : rear);
 const {c,frames}=controller();assert.equal(await c.start(),true);await tick();
 assert.equal(await c.switchCamera(),true);await tick();assert.equal(rear.track.stops,1);assert.equal(c.facing,'user');assert.equal(c.mirrored,true);assert.equal(frames.at(-1).mirrored,true);
 c.stop();assert.equal(front.track.stops,1);assert.equal(c.video.srcObject,null);
});
test('detector-load failure leaves live camera available for capture',async()=>{
 const s=stream();setMedia(async()=>s);const {c,statuses}=controller();c._loadDetector=async()=>{throw new Error('wasm unavailable');};
 assert.equal(await c.start(),true);await tick();assert.equal(c.running,true);assert.equal(s.track.stops,0);assert.equal(statuses.at(-1).code,'DetectorUnavailable');c.stop();
});
test('stale model completion emits nothing after stop',async()=>{
 setMedia(async()=>stream());const {c,statuses}=controller();let resolveDetector;c._loadDetector=()=>new Promise(r=>resolveDetector=r);
 await c.start();await tick();c.stop();const count=statuses.length;
 resolveDetector({setOptions:async()=>{}});await tick();assert.equal(statuses.length,count);assert.equal(statuses.at(-1).state,'stopped');assert.equal(c._raf,0);
});
test('photo inference picks the largest real face and returns source coordinates',async()=>{
 const {c,frames}=controller();const modes=[];
 c._loadDetector=async()=>({setOptions:async o=>modes.push(o.runningMode),detect:()=>({detections:[{boundingBox:{originX:200,originY:100,width:100,height:200}},{boundingBox:{originX:10,originY:20,width:400,height:400}}]})});
 const result=await c.detectImage({naturalWidth:1000,naturalHeight:500});
 assert.equal(result.faceCount,2);assert.deepEqual(result.box,{x:0.01,y:0.04,width:0.4,height:0.8});assert.ok(Math.abs(result.point.x-.21)<1e-9);assert.ok(Math.abs(result.point.y-.44)<1e-9);assert.equal(result.mirrored,false);assert.deepEqual(modes,['IMAGE']);assert.equal(frames.length,0);c.stop();
});
test('photo with no face has null point, not an invented result',async()=>{
 const {c}=controller();const r=await c.detectImage({width:100,height:100});assert.equal(r.point,null);assert.equal(r.faceCount,0);assert.equal(r.error,undefined);c.stop();
});
test('new photo selection invalidates earlier pending photo analysis',async()=>{
 const {c}=controller();let resolveDetector;c._loadDetector=()=>new Promise(r=>resolveDetector=r);
 const old=c.detectImage({width:100,height:100});await tick();c.stop();resolveDetector({setOptions:async()=>{},detect:()=>({detections:[]})});
 const r=await old;assert.equal(r.code,'Cancelled');assert.equal(r.point,null);
});
test('camera ended event releases the preview and offers retry',async()=>{
 const s=stream();setMedia(async()=>s);const {c,statuses}=controller();await c.start();await tick();s.track.dispatchEvent(new Event('ended'));
 assert.equal(c.running,false);assert.equal(c.video.srcObject,null);assert.equal(statuses.at(-1).code,'TrackEnded');assert.equal(c._raf,0);c.stop();
});

test('real inference failure switches to CPU and returns its face result',async()=>{
 const {c}=controller();let failures=0,closed=0,cpuCalls=0;
 const primary={setOptions:async()=>{},detect:()=>{failures++;throw new Error('WebGL context unavailable');},close:()=>closed++};
 c._detector=primary;c._loadDetector=async()=>primary;
 c._loadFallbackDetector=async()=>({setOptions:async()=>{},detect:async()=>{cpuCalls++;return {detections:[{boundingBox:{originX:30,originY:20,width:40,height:60}}]};}});
 const result=await c.detectImage({width:100,height:100});
 assert.equal(failures,1);assert.equal(cpuCalls,1);assert.equal(closed,1);assert.equal(result.faceCount,1);assert.deepEqual(result.point,{x:.5,y:.5});assert.equal(result.error,undefined);assert.equal(c._backend,'cpu');assert.equal(c._frameInterval,250);c.stop();
});

test('primary model loading failure also switches to CPU',async()=>{
 const {c}=controller();c._loadDetector=async()=>{throw new Error('MediaPipe load failed');};
 c._loadFallbackDetector=async()=>({setOptions:async()=>{},detect:async()=>({detections:[]})});
 const result=await c.detectImage({width:100,height:100});
 assert.equal(result.error,undefined);assert.equal(result.faceCount,0);assert.equal(c._backend,'cpu');c.stop();
});

test('failed CPU inference returns unavailable without recursive fallback',async()=>{
 const {c}=controller();let cpuLoads=0;c._loadDetector=async()=>{throw new Error('Primary unavailable');};
 c._loadFallbackDetector=async()=>{cpuLoads++;return {setOptions:async()=>{},detect:async()=>{throw new Error('CPU failed');}};};
 const result=await c.detectImage({width:100,height:100});
 assert.equal(cpuLoads,1);assert.equal(result.point,null);assert.equal(result.code,'DetectorUnavailable');c.stop();
});

test('stop during CPU fallback loading cancels the old photo result',async()=>{
 const {c,statuses,frames}=controller();let resolveCpu;
 c._loadDetector=async()=>({setOptions:async()=>{},detect:()=>{throw new Error('No WebGL');}});
 c._loadFallbackDetector=()=>new Promise(resolve=>resolveCpu=resolve);
 const pending=c.detectImage({width:100,height:100});await tick();c.stop();const count=statuses.length;
 resolveCpu({setOptions:async()=>{},detect:async()=>({detections:[{boundingBox:{originX:1,originY:1,width:20,height:20}}]})});
 const result=await pending;assert.equal(result.code,'Cancelled');assert.equal(frames.length,0);assert.equal(statuses.length,count);
});

const personFrame={kind:'person',point:{x:.5,y:.8},box:{x:.4,y:.2,width:.2,height:.6},sourceWidth:100,sourceHeight:100,mirrored:false,faceCount:0,personCount:1};

test('default photo detection still returns face kind',async()=>{
 const {c}=controller();assert.equal(c.detectionMode,'face');const result=await c.detectImage({width:100,height:100});
 assert.equal(result.kind,'face');assert.equal(result.personCount,0);c.stop();
});

test('selecting person while stopped does not load either model',async()=>{
 const {c,frames,statuses}=controller();let loads=0;
 c._getPersonDetector=()=>{loads++;throw new Error('Must remain lazy');};
 assert.equal(await c.setDetectionMode('person'),true);assert.equal(c.detectionMode,'person');assert.equal(loads,0);assert.equal(frames.length,0);assert.equal(statuses.length,0);c.stop();
});

test('photo person override returns a foot proxy without changing selected mode',async()=>{
 const {c}=controller();let detections=0;
 c._personDetector={invalidate(){},detect:async()=>{detections++;return personFrame;}};
 const result=await c.detectImage({width:100,height:100},{mode:'person'});
 assert.deepEqual(result,personFrame);assert.equal(detections,1);assert.equal(c.detectionMode,'face');c.stop();
});

test('changing kind invalidates an old photo result',async()=>{
 const {c}=controller();let finish;
 c._personDetector={invalidate(){},detect:()=>new Promise(r=>finish=r)};
 await c.setDetectionMode('person');const pending=c.detectImage({width:100,height:100});
 await c.setDetectionMode('face');finish(personFrame);
 const result=await pending;assert.equal(result.code,'Cancelled');assert.equal(result.kind,'person');assert.equal(result.point,null);c.stop();
});

test('person live mode loads its model and never loads the face model',async()=>{
 setMedia(async()=>stream());const {c,frames,statuses}=controller();let loads=0;
 c._personDetector={execution:'worker-cpu',invalidate(){},load:async()=>{loads++;},detect:async()=>personFrame};
 c._loadDetector=async()=>{throw new Error('Face model must not load');};
 await c.setDetectionMode('person');await c.start();await tick();
 assert.equal(loads,1);assert.equal(frames[0].kind,'person');assert.equal(statuses.at(-1).state,'ready');assert.match(statuses.at(-1).message,/人物/);c.stop();
});

test('late live person result is dropped after switching back to face',async()=>{
 setMedia(async()=>stream());const {c,frames}=controller();let finish;
 c._personDetector={execution:'worker-cpu',invalidate(){},load:async()=>{},detect:()=>new Promise(r=>finish=r)};
 await c.setDetectionMode('person');await c.start();await tick();c._lastInference=-Infinity;c.video.currentTime=2;
 const pending=c._detectFrame(c._generation,c._modeGeneration);await tick();
 await c.setDetectionMode('face');const count=frames.length;finish(personFrame);await pending;
 assert.equal(frames.length,count);assert.equal(frames.at(-1).kind,'face');assert.equal(c.detectionMode,'face');c.stop();
});

test('stop while person model loads suppresses its late ready status',async()=>{
 setMedia(async()=>stream());const {c,statuses}=controller();let finish;
 c._personDetector={execution:'worker-cpu',invalidate(){},load:()=>new Promise(r=>finish=r)};
 await c.setDetectionMode('person');await c.start();await tick();c.stop();const count=statuses.length;finish();await tick();
 assert.equal(statuses.length,count);assert.equal(statuses.at(-1).state,'stopped');assert.equal(c._raf,0);
});

function candidate(x,y,width,height,confidence=.8){
 return {box:{x,y,width,height},confidence};
}
function candidateFrame(candidates,overrides={}){
 return {kind:'person',sourceWidth:1000,sourceHeight:1000,mirrored:false,
  faceCount:0,personCount:candidates.length,candidates,...overrides};
}

test('live selection keeps the same person when another accepted box becomes larger',()=>{
 const selector=new SubjectSelector();
 const first=selector.select(candidateFrame([candidate(.1,.15,.2,.6,.71),candidate(.65,.2,.15,.5,.94)]),{capturedAtMs:0});
 const second=selector.select(candidateFrame([candidate(.65,.15,.25,.65,.94),candidate(.12,.16,.19,.58,.73)]),{capturedAtMs:300});
 assert.equal(second.subjectKey,first.subjectKey);
 assert.deepEqual(second.box,{x:.12,y:.16,width:.19,height:.58});
 assert.deepEqual(second.point,{x:.12+.19/2,y:.16+.58});
 assert.equal(second.confidence,.73);
 assert.equal(second.personCount,2);
});

test('a missing tall person does not immediately switch to a neighbouring person',()=>{
 const selector=new SubjectSelector();
 const first=selector.select(candidateFrame([candidate(.1,.1,.15,.7)]),{capturedAtMs:0});
 const neighbour=candidateFrame([candidate(.32,.1,.15,.7)]);
 const missing=selector.select(neighbour,{capturedAtMs:300});
 assert.equal(missing.point,null);assert.equal(missing.box,null);assert.equal(missing.confidence,null);assert.equal(missing.subjectKey,null);
 const reacquired=selector.select(neighbour,{capturedAtMs:600});
 assert.ok(reacquired.subjectKey);assert.notEqual(reacquired.subjectKey,first.subjectKey);
 assert.equal(reacquired.point.x,.32+.15/2);
});

test('one empty observation clears position without destroying a short continuous reacquisition',()=>{
 const selector=new SubjectSelector();
 const first=selector.select(candidateFrame([candidate(.1,.1,.2,.6)]),{capturedAtMs:0});
 const empty=selector.select(candidateFrame([]),{capturedAtMs:300});
 assert.equal(empty.point,null);assert.equal(empty.subjectKey,null);assert.equal(empty.confidence,null);
 const returned=selector.select(candidateFrame([candidate(.12,.12,.2,.6)]),{capturedAtMs:600});
 assert.equal(returned.subjectKey,first.subjectKey);
 assert.equal(returned.point.x,.22);
});

test('source dimensions, mirror, kind and explicit reset all issue a fresh geometric key',()=>{
 const selector=new SubjectSelector();const person=candidateFrame([candidate(.1,-.1,.2,1.2)]);
 const first=selector.select(person,{capturedAtMs:0});
 const mirrored=selector.select({...person,mirrored:true},{capturedAtMs:100});
 const resized=selector.select({...person,mirrored:true,sourceWidth:1200},{capturedAtMs:200});
 const face=selector.select({...person,kind:'face',mirrored:true,sourceWidth:1200},{capturedAtMs:300});
 selector.reset();const reset=selector.select({...person,kind:'face',mirrored:true,sourceWidth:1200},{capturedAtMs:400});
 assert.equal(new Set([first,mirrored,resized,face,reset].map(frame=>frame.subjectKey)).size,5);
 assert.deepEqual(first.box,person.candidates[0].box); // Crop evidence stays outside 0..1.
 assert.equal(mirrored.point.x,first.point.x); // Display mirroring remains the UI's job.
 assert.equal(face.point.y,-.1+1.2/2);
});

test('a long observation gap cannot reuse the previous subject key',()=>{
 const selector=new SubjectSelector();const frame=candidateFrame([candidate(.1,.1,.2,.6,null)]);
 const first=selector.select(frame,{capturedAtMs:0,expectedIntervalMs:300});
 const returned=selector.select(frame,{capturedAtMs:1600,expectedIntervalMs:300});
 assert.notEqual(returned.subjectKey,first.subjectKey);assert.equal(returned.confidence,null);
});

test('face output retains true scores for every candidate and does not invent unknown confidence',async()=>{
 const {c}=controller();
 c._loadDetector=async()=>({setOptions:async()=>{},detect:()=>({detections:[
  {boundingBox:{originX:10,originY:20,width:20,height:20},categories:[{score:.62}]},
  {boundingBox:{originX:40,originY:20,width:40,height:60}},
 ]})});
 const frame=await c.detectImage({width:100,height:100});
 assert.equal(frame.confidence,null);assert.equal(frame.candidates[0].confidence,.62);assert.equal(frame.candidates[1].confidence,null);
 c.stop();
});

test('real empty live observations have monotonic IDs and same-frame redraws add no observations',async()=>{
 setMedia(async()=>stream());const {c,frames}=controller();
 await c.start();await tick();
 assert.equal(frames.at(-1).observationId,null); // Opening the stream is not a model observation.
 await c._detectFrame(c._generation,c._modeGeneration);
 const first=frames.at(-1);assert.equal(first.observationId,1);assert.equal(first.point,null);assert.equal(first.confidence,null);
 assert.equal(first.subjectKey,null);assert.ok(Number.isFinite(first.capturedAtMs));assert.ok(first.expectedIntervalMs>=125);
 c._lastInference=-Infinity;await c._detectFrame(c._generation,c._modeGeneration);
 assert.equal(frames.at(-1).observationId,1);
 c.video.currentTime=2;c._lastInference=-Infinity;await c._detectFrame(c._generation,c._modeGeneration);
 assert.equal(frames.at(-1).observationId,2);
 c.stop();await c.start();await tick();c.video.currentTime=3;
 await c._detectFrame(c._generation,c._modeGeneration);
 assert.equal(frames.at(-1).observationId,3);c.stop();
});

test('only one live inference is in flight and stopping prevents its late result',async()=>{
 setMedia(async()=>stream());const {c,frames}=controller();let finish,calls=0,cancelled;
 c._personDetector={execution:'worker-cpu',invalidate(){},load:async()=>{},detect:(_media,options)=>{
  calls++;cancelled=options.isCancelled;return new Promise(resolve=>finish=resolve);
 }};
 await c.setDetectionMode('person');await c.start();await tick();
 const pending=c._detectFrame(c._generation,c._modeGeneration);await tick();
 c.video.currentTime=2;c._lastInference=-Infinity;
 await c._detectFrame(c._generation,c._modeGeneration);
 assert.equal(calls,1);assert.equal(cancelled(),false);
 c.stop();const count=frames.length;assert.equal(cancelled(),true);finish(personFrame);await pending;
 assert.equal(frames.length,count);assert.equal(c._raf,0);assert.equal(c._frameTimer,0);assert.equal(c._liveInference,null);
});

test('the newly selected detector resumes after an obsolete live inference finishes',async()=>{
 setMedia(async()=>stream());const {c,frames}=controller();let finish;
 c._personDetector={execution:'worker-cpu',invalidate(){},load:async()=>{},detect:()=>new Promise(resolve=>finish=resolve)};
 await c.setDetectionMode('person');await c.start();await tick();
 const pending=c._detectFrame(c._generation,c._modeGeneration);await tick();
 await c.setDetectionMode('face');const count=frames.length;
 assert.equal(c._raf,0);finish(personFrame);await pending;
 assert.equal(frames.length,count);assert.ok(c._raf);assert.equal(c._liveInference,null);
 c.video.currentTime=2;await c._detectFrame(c._generation,c._modeGeneration);
 assert.equal(frames.at(-1).kind,'face');assert.equal(frames.at(-1).observationId,1);c.stop();
});

test('video-frame callbacks are preferred and cancelled when the camera stops',async()=>{
 setMedia(async()=>stream());const {c,frames}=controller();let nextId=0;const videoFrames=new Map();
 c.video.requestVideoFrameCallback=callback=>{videoFrames.set(++nextId,callback);return nextId;};
 c.video.cancelVideoFrameCallback=id=>videoFrames.delete(id);
 await c.start();await tick();assert.equal(videoFrames.size,1);assert.equal(c._raf,0);
 const callback=videoFrames.get(c._videoFrameRequest);videoFrames.clear();
 callback(performance.now(),{mediaTime:1});await tick();
 assert.equal(frames.at(-1).observationId,1);assert.equal(c._raf,0);
 c._cancelFrameSchedule();c._lastInference=-Infinity;c._scheduleFrame(c._generation,c._modeGeneration);
 assert.equal(videoFrames.size,1);c.stop();assert.equal(videoFrames.size,0);assert.equal(c._videoFrameRequest,0);assert.equal(c._frameTimer,0);
});

test('unsupported or partial video-frame APIs retain the animation-frame fallback',async()=>{
 setMedia(async()=>stream());const {c}=controller();
 c.video.requestVideoFrameCallback=()=>{throw new Error('Not supported');};
 await c.start();await tick();assert.ok(c._raf);assert.equal(c._videoFrameRequest,0);c.stop();
});

test('person observation cadence uses measured work and retains genuine empty-result metadata',async()=>{
 setMedia(async()=>stream());const {c,frames}=controller();let duration=80,empty=false;
 c._personDetector={execution:'worker-cpu',invalidate(){},load:async()=>{},detect:async()=>({
  ...(empty?{...personFrame,point:null,box:null,personCount:0,candidates:[]}:personFrame),
  capturedAtMs:performance.now()-duration,inferenceDurationMs:duration,confidence:empty?null:.75,
 })};
 await c.setDetectionMode('person');await c.start();await tick();
 await c._detectFrame(c._generation,c._modeGeneration);
 const first=frames.at(-1);assert.equal(first.expectedIntervalMs,300);assert.equal(first.inferenceDurationMs,80);
 assert.equal(first.confidence,.75);assert.ok(first.subjectKey);assert.ok(performance.now()-first.capturedAtMs>=80);
 duration=640;empty=true;c.video.currentTime=2;c._lastInference=-Infinity;
 await c._detectFrame(c._generation,c._modeGeneration);
 const second=frames.at(-1);assert.equal(second.expectedIntervalMs,800);assert.equal(second.observationId,first.observationId+1);
 assert.equal(second.point,null);assert.equal(second.subjectKey,null);assert.equal(second.confidence,null);
 c._personDetector.execution='main-cpu';assert.equal(c._detectionInterval(),1280);c.stop();
});

function zoomStream({min=1,max=6,step=.1,value=1,facing='environment'}={}){
 const s=stream(facing);s.zoom=value;s.calls=[];
 s.track.getCapabilities=()=>({zoom:{min,max,step}});
 s.track.getSettings=()=>({facingMode:facing,zoom:s.zoom});
 s.track.getConstraints=()=>({width:{ideal:1920},height:{ideal:1440},frameRate:{ideal:24,max:30},advanced:[{torch:false,zoom:1}]});
 s.track.applyConstraints=async constraints=>{s.calls.push(constraints);s.zoom=constraints.advanced.at(-1).zoom;};
 return s;
}

test('user-initiated camera request asks for zoom only when the browser exposes that constraint',async()=>{
 for(const supported of [true,false]){
  let requested;setMedia(async options=>{requested=options;return zoomStream();});
  navigator.mediaDevices.getSupportedConstraints=()=>({zoom:supported});
  const {c}=controller();await c.start();assert.equal(requested.video.zoom,supported?true:undefined);
  assert.equal(requested.video.pan,undefined);assert.equal(requested.video.tilt,undefined);assert.equal(requested.audio,false);c.stop();
 }
});

test('zoom capability is read only after video becomes ready and snapshots cannot mutate it',async()=>{
 const s=zoomStream({min:.5,max:5,step:.05,value:1.25});setMedia(async()=>s);
 const {c}=controller();c.video.readyState=0;let capabilityReads=0;
 const read=s.track.getCapabilities;s.track.getCapabilities=()=>{capabilityReads++;return read();};
 const states=[];c.onZoom=z=>states.push(z);
 const pending=c.start();await tick();assert.equal(capabilityReads,0);assert.equal(c.getZoomState().supported,false);
 c.video.readyState=2;c.video.dispatchEvent(new Event('canplay'));assert.equal(await pending,true);
 assert.deepEqual(c.getZoomState(),{supported:true,mode:'track',min:.5,max:5,step:.05,value:1.25,pending:false,requested:null,error:null});
 const detached=c.getZoomState();detached.max=500;assert.equal(c.getZoomState().max,5);assert.equal(states.at(-1).value,1.25);c.stop();
});

test('missing, fixed, invalid and unreadable camera zoom cannot invent a lens capability',async()=>{
 for(const setup of [
  s=>{delete s.track.getCapabilities;},
  s=>{s.track.getCapabilities=()=>({zoom:{min:1,max:1,step:.1}});},
  s=>{s.track.getCapabilities=()=>({zoom:{min:0,max:4,step:.1}});},
  s=>{s.track.getSettings=()=>({facingMode:'environment'});},
  s=>{s.track.getCapabilities=()=>{throw new Error('unavailable');};},
  s=>{delete s.track.applyConstraints;},
 ]){
  const s=zoomStream();setup(s);setMedia(async()=>s);const {c}=controller();
  await c.start();assert.equal(c.getZoomState().supported,false);assert.equal(c.getZoomState().mode,'unavailable');
  assert.equal(await c.setZoom(2),false);assert.equal(s.calls.length,0);c.stop();
 }
});

test('track zoom clamps and snaps to the reported range while retaining existing constraints',async()=>{
 const s=zoomStream({min:1,max:4,step:.25});setMedia(async()=>s);const {c,frames}=controller();
 await c.start();await tick();assert.equal(await c.setZoom(2.12),true);assert.equal(c.getZoomState().value,2);
 assert.deepEqual(s.calls[0],{width:{ideal:1920},height:{ideal:1440},frameRate:{ideal:24,max:30},advanced:[{torch:false},{zoom:2}]});
 assert.equal(frames.at(-1).point,null);assert.equal(frames.at(-1).observationId,null);
 assert.equal(await c.setZoom(100),true);assert.equal(c.getZoomState().value,4);
 assert.equal(await c.setZoom(.1),true);assert.equal(c.getZoomState().value,1);
 const count=s.calls.length;assert.equal(await c.setZoom(NaN),false);assert.equal(await c.setZoom(1),true);assert.equal(s.calls.length,count);c.stop();
});

test('continuous camera zoom does not invent a discrete device step',async()=>{
 const s=zoomStream({step:0});setMedia(async()=>s);const {c}=controller();await c.start();
 assert.equal(c.getZoomState().step,0);assert.equal(await c.setZoom(1.333),true);assert.equal(s.zoom,1.333);c.stop();
});

test('a rejected zoom keeps the actual setting and leaves detection usable',async()=>{
 const s=zoomStream();s.track.applyConstraints=async()=>{throw Object.assign(new Error('no'),{name:'OverconstrainedError'});};
 setMedia(async()=>s);const {c}=controller();await c.start();await tick();
 assert.equal(await c.setZoom(3),false);await tick();const z=c.getZoomState();
 assert.equal(z.value,1);assert.equal(z.pending,false);assert.equal(z.error.code,'OverconstrainedError');assert.equal(c.running,true);assert.equal(c._detectorActive,true);
 z.error.code='changed';assert.equal(c.getZoomState().error.code,'OverconstrainedError');c.stop();
});

test('silently ignored advanced zoom constraints never report the requested value as applied',async()=>{
 const s=zoomStream();s.track.applyConstraints=async constraints=>s.calls.push(constraints);
 setMedia(async()=>s);const {c}=controller();await c.start();assert.equal(await c.setZoom(3),false);
 assert.equal(c.getZoomState().value,1);assert.equal(c.getZoomState().error.code,'ZoomNotApplied');c.stop();
});

test('losing actual setting readback disables hardware zoom instead of trusting the requested value',async()=>{
 const s=zoomStream();s.track.applyConstraints=async()=>{s.track.getSettings=()=>({facingMode:'environment'});};
 setMedia(async()=>s);const {c}=controller();await c.start();assert.equal(await c.setZoom(3),false);
 assert.equal(c.getZoomState().supported,false);assert.equal(c.getZoomState().error.code,'ZoomUnverified');c.stop();
});

test('rapid zoom inputs serialize actual device calls and skip superseded queued requests',async()=>{
 const s=zoomStream();let finishFirst;
 s.track.applyConstraints=constraints=>{
  const target=constraints.advanced.at(-1).zoom;s.calls.push(target);
  if(s.calls.length===1)return new Promise(resolve=>{finishFirst=()=>{s.zoom=target;resolve();};});
  s.zoom=target;return Promise.resolve();
 };
 setMedia(async()=>s);const {c}=controller();const states=[];c.onZoom=z=>states.push(z);await c.start();await tick();
 const first=c.setZoom(2);await tick();const second=c.setZoom(3),last=c.setZoom(4);await tick();
 assert.deepEqual(s.calls,[2]);assert.equal(c.getZoomState().pending,true);assert.equal(c.getZoomState().requested,4);
 finishFirst();assert.deepEqual(await Promise.all([first,second,last]),[false,false,true]);
 assert.deepEqual(s.calls,[2,4]);assert.equal(c.getZoomState().value,4);assert.equal(c.getZoomState().pending,false);
 assert.equal(states.some(state=>state.value===2),false);c.stop();
});

test('stopping resolves an in-flight zoom promptly and its late completion cannot revive state',async()=>{
 const s=zoomStream();let finish;
 s.track.applyConstraints=()=>new Promise(resolve=>{finish=()=>{s.zoom=4;resolve();};});
 setMedia(async()=>s);const {c}=controller();const states=[];c.onZoom=z=>states.push(z);await c.start();
 const pending=c.setZoom(4);await tick();c.stop();assert.equal(await pending,false);
 const count=states.length;finish();await tick();assert.equal(states.length,count);assert.equal(c.getZoomState().supported,false);assert.equal(c.running,false);
});

test('camera switch resets zoom range and obsolete constraints never affect the new UI',async()=>{
 const rear=zoomStream(),front=zoomStream({facing:'user',min:1,max:2,step:.5,value:1.5});let requests=0,finish;
 rear.track.applyConstraints=()=>new Promise(resolve=>{finish=()=>{rear.zoom=6;resolve();};});
 setMedia(async()=>requests++?front:rear);const {c}=controller();await c.start();const pending=c.setZoom(6);await tick();
 await c.switchCamera();assert.equal(await pending,false);assert.equal(c.getZoomState().max,2);assert.equal(c.getZoomState().value,1.5);
 finish();await tick();assert.equal(c.getZoomState().value,1.5);assert.equal(await c.setZoom(2),true);assert.equal(front.zoom,2);c.stop();
});

test('zoom invalidates an old inference and detector changes stay paused until constraints settle',async()=>{
 const s=zoomStream();let finishZoom,finishInference;
 s.track.applyConstraints=()=>new Promise(resolve=>{finishZoom=()=>{s.zoom=2;resolve();};});
 setMedia(async()=>s);const {c,frames}=controller();
 c._loadDetector=async()=>({setOptions:async()=>{},detectForVideo:()=>new Promise(resolve=>{finishInference=resolve;})});
 c._personDetector={execution:'worker-cpu',invalidate(){},load:async()=>{},detect:async()=>personFrame};
 await c.start();await tick();const inference=c._detectFrame(c._generation,c._modeGeneration);await tick();
 const zoom=c.setZoom(2);await tick();await c.setDetectionMode('person');assert.equal(c._detectorActive,false);
 const count=frames.length;finishInference({detections:[{boundingBox:{originX:1,originY:1,width:20,height:20}}]});await inference;
 assert.equal(frames.length,count);assert.equal(c._raf,0);finishZoom();assert.equal(await zoom,true);await tick();
 assert.equal(c._detectorActive,true);assert.equal(c.detectionMode,'person');assert.ok(c._raf);c.stop();
});

function exposureStream({mode='continuous',ev=0,step=1/3}={}) {
 const s=zoomStream();s.ev=ev;s.exposureMode=mode;s.constraints={width:{ideal:1920},advanced:[{torch:false}]};
 s.track.getCapabilities=()=>({zoom:{min:1,max:6,step:.1},exposureCompensation:{min:-2,max:2,step},exposureMode:['continuous','manual','single-shot']});
 s.track.getSettings=()=>({facingMode:'environment',zoom:s.zoom,exposureMode:s.exposureMode,exposureCompensation:s.ev});
 s.track.getConstraints=()=>s.constraints;
 s.apply=constraints=>{
  s.constraints=structuredClone(constraints);
  for(const entry of constraints.advanced||[]){
   if(Number.isFinite(entry.zoom))s.zoom=entry.zoom;
   if(Number.isFinite(entry.exposureCompensation))s.ev=entry.exposureCompensation;
  }
 };
 s.track.applyConstraints=async constraints=>{s.calls.push(structuredClone(constraints));s.apply(constraints);};
 return s;
}

test('exposure requires an actual EV range, setting, and automatic exposure mode',async()=>{
 for(const mode of ['continuous','single-shot','manual','none',undefined]){
  const s=exposureStream({mode:mode===undefined?'continuous':mode});s.exposureMode=mode;setMedia(async()=>s);
  const {c}=controller();const states=[];c.onExposure=x=>states.push(x);await c.start();
  const e=c.getExposureState(),allowed=['continuous','single-shot'].includes(mode);
  assert.equal(e.supported,allowed);assert.equal(e.unit,'EV');assert.equal(e.value,allowed?0:null);
  if(allowed){assert.equal(e.meteringMode,mode);assert.equal(e.min,-2);assert.equal(e.max,2);}
  else{assert.equal(await c.setExposureCompensation(.5),false);assert.equal(s.calls.length,0);}
  e.max=999;assert.notEqual(c.getExposureState().max,999);assert.ok(states.length);c.stop();
 }
});

test('missing or unreadable exposure range and settings cannot become manual parameter controls',async()=>{
 for(const change of [
  s=>{s.track.getCapabilities=()=>({exposureCompensation:{min:0,max:0,step:0}});},
  s=>{s.ev=undefined;},
  s=>{s.track.getCapabilities=()=>({});},
  s=>{s.track.getCapabilities=()=>{throw new Error('no capability');};},
 ]){
  const s=exposureStream();change(s);setMedia(async()=>s);const {c}=controller();await c.start();
  assert.equal(c.getExposureState().supported,false);assert.equal(c.getExposureState().value,null);
  assert.equal(await c.setExposureCompensation(1),false);assert.equal(s.calls.length,0);c.stop();
 }
});

test('EV applies clamped discrete hardware steps while retaining zoom and unrelated constraints',async()=>{
 const s=exposureStream();setMedia(async()=>s);const {c}=controller();await c.start();
 assert.equal(await c.setZoom(2),true);assert.equal(await c.setExposureCompensation(.61),true);
 assert.ok(Math.abs(c.getExposureState().value-2/3)<1e-8);assert.equal(c.getZoomState().value,2);
 assert.deepEqual(s.calls.at(-1).width,{ideal:1920});assert.deepEqual(s.calls.at(-1).advanced[0],{torch:false});
 assert.equal(s.calls.at(-1).advanced.at(-1).zoom,2);
 assert.equal(await c.setExposureCompensation(99),true);assert.equal(c.getExposureState().value,2);
 const count=s.calls.length;assert.equal(await c.setExposureCompensation(2),true);assert.equal(await c.setExposureCompensation(NaN),false);assert.equal(s.calls.length,count);c.stop();
});

test('duplicate pending targets share one device request and one observation reset',async()=>{
 const s=exposureStream();let finish;s.track.applyConstraints=constraints=>{s.calls.push(constraints);return new Promise(resolve=>{finish=()=>{s.apply(constraints);resolve();};});};
 setMedia(async()=>s);const {c,frames}=controller();await c.start();await tick();const base=frames.length,mode=c._modeGeneration;
 const a=c.setZoom(2),b=c.setZoom(2.001);assert.equal(a,b);await tick();
 assert.equal(s.calls.length,1);assert.equal(frames.length,base+1);assert.equal(c._modeGeneration,mode+1);
 finish();assert.equal(await a,true);c.stop();
});

test('zoom and EV share a serial queue and preserve the actual companion value',async()=>{
 const s=exposureStream();let finish,active=0,maxActive=0;
 s.track.applyConstraints=constraints=>{
  active++;maxActive=Math.max(maxActive,active);s.calls.push(structuredClone(constraints));
  if(s.calls.length===1)return new Promise(resolve=>{finish=()=>{s.apply(constraints);active--;resolve();};});
  s.apply(constraints);active--;return Promise.resolve();
 };
 setMedia(async()=>s);const {c,frames}=controller();await c.start();await tick();const before=frames.length;
 const first=c.setZoom(2);await tick();const ev=c.setExposureCompensation(.6),zoom=c.setZoom(3);
 assert.equal(c.getZoomState().pending||c.getExposureState().pending,true);assert.equal(frames.length,before+1);
 finish();assert.deepEqual(await Promise.all([first,ev,zoom]),[false,true,true]);
 assert.equal(maxActive,1);assert.equal(s.calls.length,3);
 assert.equal(s.calls[1].advanced.at(-1).zoom,2);
 assert.ok(Math.abs(s.calls[2].advanced.at(-1).exposureCompensation-2/3)<1e-8);
 assert.equal(c.getZoomState().value,3);assert.ok(Math.abs(c.getExposureState().value-2/3)<1e-8);
 assert.equal(c._controlsPending(),false);await tick();assert.equal(c._detectorActive,true);c.stop();
});

test('rapid targets during the submission interval skip obsolete hardware requests',async()=>{
 const s=zoomStream();setMedia(async()=>s);const {c,frames}=controller();await c.start();await c.setZoom(2);await tick();
 const before=frames.length,mode=c._modeGeneration;
 const a=c.setZoom(2.5);await tick();const b=c.setZoom(3),d=c.setZoom(4);await tick();
 assert.equal(s.calls.length,1);assert.equal(frames.length,before+1);assert.equal(c._modeGeneration,mode+1);
 assert.deepEqual(await Promise.all([a,b,d]),[false,false,true]);assert.equal(s.calls.length,2);assert.equal(c.getZoomState().value,4);c.stop();
});

test('silently ignored or rejected EV adjustments report the actual value and permit recovery',async()=>{
 for(const reject of [false,true]){
  const s=exposureStream();s.track.applyConstraints=async()=>{if(reject)throw Object.assign(new Error(),{name:'OverconstrainedError'});};
  setMedia(async()=>s);const {c}=controller();await c.start();assert.equal(await c.setExposureCompensation(1),false);await tick();
  const e=c.getExposureState();assert.equal(e.value,0);assert.equal(e.pending,false);assert.equal(e.error.code,reject?'OverconstrainedError':'ExposureNotApplied');
  e.error.code='mutated';assert.notEqual(c.getExposureState().error.code,'mutated');assert.equal(c._detectorActive,true);c.stop();
 }
});

test('an unverified EV readback disables control instead of using its requested value',async()=>{
 const s=exposureStream();s.track.applyConstraints=async()=>{s.ev=undefined;};setMedia(async()=>s);const {c}=controller();await c.start();
 assert.equal(await c.setExposureCompensation(1),false);assert.equal(c.getExposureState().supported,false);
 assert.equal(c.getExposureState().value,null);assert.equal(c.getExposureState().error.code,'ExposureUnverified');c.stop();
});

test('EV queued after a metering-mode change cannot silently switch manual exposure',async()=>{
 const s=exposureStream();let finish;s.track.applyConstraints=constraints=>{s.calls.push(constraints);return new Promise(resolve=>{finish=()=>{s.apply(constraints);s.exposureMode='manual';resolve();};});};
 setMedia(async()=>s);const {c}=controller();await c.start();const zoom=c.setZoom(2);await tick();const exposure=c.setExposureCompensation(1);
 finish();assert.equal(await zoom,true);assert.equal(await exposure,false);assert.equal(s.calls.length,1);
 assert.equal(c.getExposureState().supported,false);assert.equal(c.getExposureState().reason,'manual_exposure');c.stop();
});

test('stopping cancels a rate-limited control before another device call begins',async()=>{
 const s=exposureStream();setMedia(async()=>s);const {c}=controller();c._constraintIntervalMs=200;await c.start();await c.setZoom(2);
 const pending=c.setExposureCompensation(1);await tick();c.stop();assert.equal(await pending,false);
 assert.equal(s.calls.length,1);assert.equal(c.getExposureState().pending,false);assert.equal(c.getExposureState().supported,false);
});

test('late EV completion after camera switching cannot overwrite the new camera controls',async()=>{
 const rear=exposureStream(),front=exposureStream({ev:-1});let requests=0,finish;
 rear.track.applyConstraints=constraints=>new Promise(resolve=>{finish=()=>{rear.apply(constraints);resolve();};});
 setMedia(async()=>requests++?front:rear);const {c}=controller();await c.start();const ev=c.setExposureCompensation(1);await tick();
 await c.switchCamera();assert.equal(await ev,false);assert.equal(c.getExposureState().value,-1);
 finish();await tick();assert.equal(c.getExposureState().value,-1);assert.equal(await c.setExposureCompensation(0),true);c.stop();
});

test('changing EV refreshes unexpected companion zoom changes from actual device settings',async()=>{
 const s=exposureStream();setMedia(async()=>s);const {c}=controller();const seen=[];c.onZoom=z=>seen.push(z);
 await c.start();await c.setZoom(2);s.track.applyConstraints=async constraints=>{s.apply(constraints);s.zoom=2.1;};
 assert.equal(await c.setExposureCompensation(1),true);assert.equal(c.getZoomState().value,2.1);assert.equal(seen.at(-1).value,2.1);c.stop();
});

test('unknown controls in existing constraints are preserved rather than dropped by zoom',async()=>{
 const s=zoomStream();s.track.getConstraints=()=>({exposureCompensation:{ideal:.5},advanced:[{exposureCompensation:.5,torch:false,zoom:1}]});
 setMedia(async()=>s);const {c}=controller();await c.start();assert.equal(await c.setZoom(2),true);
 assert.deepEqual(s.calls[0].exposureCompensation,{ideal:.5});assert.deepEqual(s.calls[0].advanced[0],{exposureCompensation:.5,torch:false});c.stop();
});
