import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeScene,createSceneStabilizer} from '../dist/scene-analysis.mjs';

function image(width=40,height=40,paint=()=>128) {
  const pixels=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const value=paint(x,y),rgba=Array.isArray(value)?value:[value,value,value,255];
    pixels.set(rgba,(y*width+x)*4);
  }
  return {pixels,width,height};
}
const analyze=(value,extra={})=>analyzeScene({...image(40,40,()=>value),sourceKey:'camera:1',...extra});
const near=(a,b,tolerance=.005)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} versus ${b}`);

test('uniform midtone has an honest display histogram and no invented subject or sensor values',()=>{
  const result=analyze(128);
  assert.equal(result.ok,true);assert.equal(result.condition.id,'balanced');
  for(const field of ['mean','p05','p50','p95'])near(result.metrics[field],128/255);
  assert.equal(result.metrics.histogram[128],1600);
  assert.equal(result.metrics.subjectMean,null);assert.equal(result.metrics.backlightDelta,null);
  assert.equal(result.recommendation.ev.delta,0);
  assert.equal('lux' in result.metrics,false);assert.equal('kelvin' in result.metrics,false);
  assert.equal('iso' in result.metrics,false);assert.ok(result.limitations.length>=3);
});

test('dark and nearly white frames produce distinct bounded relative advice',()=>{
  const dark=analyze(10),bright=analyze(250);
  assert.equal(dark.condition.id,'low_light');assert.equal(dark.metrics.shadowRatio,1);
  assert.equal(dark.recommendation.ev.delta,.3);
  assert.equal(bright.condition.id,'highlights');assert.equal(bright.metrics.highlightRatio,1);
  assert.equal(bright.recommendation.ev.delta,-.7);
  assert.equal(bright.recommendation.ev.advisoryOnly,true);
});

test('regional backlight needs a usable subject box and background evidence',()=>{
  const input=image(80,80,(x,y)=>x>=24&&x<56&&y>=16&&y<64?40:210);
  const withSubject=analyzeScene({...input,subjectBox:{x:.3,y:.2,width:.4,height:.6,kind:'person'}});
  assert.equal(withSubject.condition.id,'backlit');near(withSubject.metrics.subjectMean,40/255);
  near(withSubject.metrics.backgroundMean,210/255);assert.ok(withSubject.metrics.backlightDelta>.6);
  const withoutSubject=analyzeScene(input);
  assert.equal(withoutSubject.metrics.subjectMean,null);
  assert.equal(withoutSubject.conditions.some(c=>c.id==='backlit'),false);
});

test('backlit portrait against clipped white background does not blindly recommend more exposure',()=>{
  const input=image(80,80,(x,y)=>x>=24&&x<56&&y>=16&&y<64?40:255);
  const result=analyzeScene({...input,subjectBox:{x:.3,y:.2,width:.4,height:.6,kind:'person'}});
  assert.equal(result.condition.id,'backlit');assert.equal(result.recommendation.ev.delta,0);
  assert.ok(result.recommendation.ev.reason.includes('丢失背景细节'));
});

test('invalid, tiny, offscreen and full-frame boxes cannot fabricate a background comparison',()=>{
  for(const box of [{x:NaN,y:0,width:.4,height:.6},{x:2,y:.2,width:.2,height:.5},{x:.5,y:.5,width:.001,height:.001}]) {
    const result=analyze(80,{subjectBox:box});
    assert.equal(result.metrics.subjectMean,null);assert.equal(result.metrics.backlightDelta,null);
  }
  const full=analyze(80,{subjectBox:{x:0,y:0,width:1,height:1}});
  assert.equal(full.metrics.backgroundMean,null);assert.equal(full.metrics.backlightDelta,null);
});

test('transparency and malformed image inputs revoke exposure advice',()=>{
  for(const input of [image(40,40,()=>[255,255,255,0]),image(40,40,(x)=>x<20?[255,255,255,0]:[10,10,10,255]),
    {pixels:new Float32Array(64),width:4,height:4},{pixels:new Int8Array(64),width:4,height:4},{pixels:new Uint8Array(10),width:40,height:40},
    {pixels:new Uint8Array(64),width:0,height:4}]) {
    const result=analyzeScene(input);assert.equal(result.ok,false);assert.equal(result.recommendation.ev,null);
  }
});

test('local edges distinguish equally bright flat and patterned frames without naming scenery',()=>{
  const flat=analyzeScene(image(64,64,()=>128));
  const pattern=analyzeScene(image(64,64,(x,y)=>(x+y)%2?240:16));
  near(flat.metrics.mean,pattern.metrics.mean);
  assert.equal(flat.metrics.edgeDensity,0);assert.equal(pattern.metrics.edgeDensity,1);
  assert.equal(pattern.method,'display-luma-histogram-regional-contrast-local-edges');
  assert.equal('sceneClass' in pattern,false);
});

test('large inputs are deterministically sampled and intent comes only from user input',()=>{
  const input=image(640,480,()=>128);
  const still=analyzeScene({...input,intent:'still'}),motion=analyzeScene({...input,intent:'motion'});
  assert.ok(still.metrics.samples<=192*192);near(still.metrics.mean,128/255);
  assert.deepEqual(still.metrics,motion.metrics);assert.equal(still.condition.id,motion.condition.id);
  assert.notDeepEqual(still.recommendation.parameterHints,motion.recommendation.parameterHints);
  assert.ok(motion.recommendation.parameterHints[0].reason.includes('未测量运动'));
});

test('live stability requires distinct observations across time and repeated painting cannot count',()=>{
  const guard=createSceneStabilizer();guard.reset('camera:1');const analysis=analyze(128);
  assert.equal(guard.update(analysis,{now:100,observationId:1}).stable,false);
  const duplicate=guard.update(analysis,{now:600,observationId:1});
  assert.equal(duplicate.stable,false);assert.equal(duplicate.samples,1);assert.equal(duplicate.reason,'duplicate_observation');
  assert.equal(guard.update(analysis,{now:200,observationId:2}).stable,false);
  assert.equal(guard.update(analysis,{now:500,observationId:3}).stable,true);
});

test('light change revokes old stable advice immediately and stale samples expire',()=>{
  const guard=createSceneStabilizer();guard.reset('camera:1');
  guard.update(analyze(128),{now:0,observationId:1});
  assert.equal(guard.update(analyze(128),{now:500,observationId:2}).stable,true);
  const changed=guard.update(analyze(250),{now:1000,observationId:3});
  assert.equal(changed.stable,false);assert.equal(changed.analysis.condition.id,'highlights');
  assert.equal(guard.update(analyze(250),{now:1500,observationId:4}).stable,true);
  const expired=guard.get(3401);assert.equal(expired.stable,false);assert.equal(expired.analysis,null);assert.equal(expired.expired,true);
  assert.equal(guard.update(analyze(250),{now:3500,observationId:5}).stable,false);
});

test('source reset and timestamp guards reject late results instead of returning them as current',()=>{
  const guard=createSceneStabilizer();guard.reset('new');
  const old=analyze(250,{sourceKey:'old'}),fresh=analyze(128,{sourceKey:'new'});
  const rejected=guard.update(old,{now:100,observationId:1});assert.equal(rejected.analysis,null);assert.equal(rejected.reason,'wrong_source');
  guard.update(fresh,{now:200,observationId:2});
  assert.equal(guard.update(fresh,{now:600,observationId:3}).stable,true);
  assert.equal(guard.update(old,{now:700,observationId:4}).analysis.sourceKey,'new');
  assert.equal(guard.update(analyze(250,{sourceKey:'new'}),{now:400,observationId:5}).reason,'old_observation');
  const bad=analyzeScene({sourceKey:'new'});
  const cleared=guard.update(bad,{now:800,observationId:6});assert.equal(cleared.analysis,null);assert.equal(cleared.stable,false);
  const afterInvalid=guard.update(fresh,{now:750,observationId:7});assert.equal(afterInvalid.analysis,null);assert.equal(afterInvalid.reason,'old_observation');
});

test('invalid timing configuration and missing observation identities cannot establish stability',()=>{
  assert.throws(()=>createSceneStabilizer({minSamples:1}),RangeError);
  assert.throws(()=>createSceneStabilizer({maxAgeMs:100}),RangeError);
  const guard=createSceneStabilizer();guard.reset('camera:1');
  assert.equal(guard.update(analyze(128),{now:NaN,observationId:1}).analysis,null);
  assert.equal(guard.update(analyze(128),{now:10}).reason,'missing_observation_id');
});
