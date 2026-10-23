import test from 'node:test';
import assert from 'node:assert/strict';
import {POSES} from '../dist/poses.mjs';
import {targetForShot,getShotTemplateTransform} from '../dist/shots.mjs';
import {getPoseGeometry,computePoseFootprint,constrainPoseTarget,analyzeTargetBackground,assessFrameCoordination,
  assessTargetBackgroundOcclusion,BACKGROUND_OCCLUSION_THRESHOLD} from '../dist/composition-engine.mjs';

const near=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} ≈ ${b}`);
const picture=(width=120,height=160,valueAt=()=>150)=>{
  const pixels=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,v=valueAt(x,y);pixels[i]=pixels[i+1]=pixels[i+2]=v;pixels[i+3]=255;
  }
  return {pixels,width,height};
};
const check=(result,code)=>result.checks.find(c=>c.code===code);
const complete={shot:'full',target:{...targetForShot({shot:'full',preset:'center'}),x:.5,y:.9},aspect:.75,
  poseId:'easy-angle',point:{x:.5,y:.9,visible:true},box:{x:.35,y:.12,width:.3,height:.78},observedKind:'person',
  sourceKey:'sample',zoomRevision:2,zoom:{mode:'digital',value:1,min:1,max:6,pending:false}};

test('every authored pose supplies its actual thirteen joints and a finite footprint',()=>{
  for(const pose of POSES){
    const g=getPoseGeometry(pose.id);
    assert.equal(g.joints.length,13);
    assert.ok(g.bounds.right>g.bounds.left&&g.bounds.bottom>g.bounds.top);
    assert.equal(g.method,'authored-svg-joints-and-linear-skeleton');
    assert.ok(Object.isFrozen(g)&&Object.isFrozen(g.points));
  }
  assert.equal(getPoseGeometry('unknown'),null);
});

test('different actions require different width at the same shot scale',()=>{
  const input={x:.5,y:.9,height:.7,aspect:.75};
  const stand=computePoseFootprint({...input,poseId:'easy-angle'});
  const open=computePoseFootprint({...input,poseId:'open-view'});
  assert.ok(open.width>stand.width*1.4);
  near(open.height,stand.height);
  const reference=getShotTemplateTransform({shot:'full',target:{x:.5,y:.9,height:.7},aspect:.75});
  for(const key of ['left','top','width','height'])near(open.template[key],reference[key]);
});

test('mirroring swaps an asymmetric outline around the target without changing size',()=>{
  const input={poseId:'easy-angle',x:.3,y:.85,height:.5,aspect:.75};
  const a=computePoseFootprint(input),b=computePoseFootprint({...input,mirrored:true});
  near(a.width,b.width);near(a.height,b.height);near(b.x,2*input.x-a.x-a.width);
  near(b.headShoulders.x,2*input.x-a.headShoulders.x-a.headShoulders.width);
});

test('full-body placement clamps actual hands, head and feet inside the frame',()=>{
  const r=constrainPoseTarget({shot:'full',target:{x:.01,y:.1,height:.78},aspect:.75,poseId:'open-view'});
  assert.equal(r.fits,true);assert.equal(r.changed,true);
  near(r.footprint.x,.02);near(r.footprint.y,.02);
  assert.ok(r.footprint.x+r.footprint.width<=.98000001);
  assert.ok(r.footprint.y+r.footprint.height<=.98000001);
});

test('an impossible pose footprint is reported without silently reducing its height',()=>{
  const r=constrainPoseTarget({shot:'full',target:{x:.5,y:.9,height:.88},aspect:.1,poseId:'open-view'});
  assert.equal(r.fits,false);assert.equal(r.target.height,.88);assert.equal(r.reason,'pose-does-not-fit');
});

test('a near shot does not force intentionally cropped legs into the frame',()=>{
  const target=targetForShot({shot:'close',preset:'center'});
  const r=assessFrameCoordination({shot:'close',target,aspect:.75,poseId:'three-quarter',point:target,
    box:{x:target.x-.12,y:target.y-target.height/2,width:.24,height:target.height},observedKind:'face'});
  assert.equal(r.geometry.intentionallyCropped,true);
  assert.ok(r.geometry.footprint.y+r.geometry.footprint.height>1);
  assert.equal(check(r,'intentional_crop').state,'pass');
  assert.equal(check(r,'pose_frame'),undefined);
  assert.equal(check(r,'subject_frame'),undefined);
  const constrained=constrainPoseTarget({shot:'close',target,aspect:.75,poseId:'three-quarter'});
  assert.equal(constrained.changed,false);
});

test('shot and custom body ratio contradictions are explained as product reference ranges',()=>{
  const r=assessFrameCoordination({...complete,shot:'extreme_wide',poseId:'open-view'});
  assert.equal(check(r,'shot_scale').state,'warn');
  assert.match(check(r,'shot_scale').detail,/项目参考范围/);
  assert.equal(r.artisticScore,null);
});

test('a pose crossing the side takes priority over a clean-looking background',()=>{
  const r=assessFrameCoordination({...complete,target:{...complete.target,x:.05},poseId:'open-view',
    background:{...picture(),sourceKey:'sample',zoomRevision:2}});
  assert.equal(r.primary.code,'pose_frame');
  assert.equal(check(r,'pose_frame').state,'warn');
});

test('a manual or example point cannot establish measured size or a zoom prescription',()=>{
  for(const observationOrigin of ['manual','example']){
    const r=assessFrameCoordination({...complete,observationOrigin});
    assert.equal(check(r,'subject_size').state,'unknown');
    assert.equal(r.zoomAdvice,null);
    assert.notEqual(r.status,'geometry-consistent');
  }
});

test('missing and wrong-kind observations cannot be accepted as an aligned subject',()=>{
  const absent=assessFrameCoordination({...complete,point:null,box:null});
  assert.equal(check(absent,'subject_position').state,'unknown');
  const wrong=assessFrameCoordination({...complete,observedKind:'face'});
  assert.equal(check(wrong,'observation_kind').state,'unknown');
  assert.equal(check(wrong,'subject_position').state,'unknown');
  assert.equal(wrong.zoomAdvice,null);
});

test('an explicitly invisible observation cannot be revived by a remaining old box',()=>{
  const r=assessFrameCoordination({...complete,point:{...complete.point,visible:false}});
  assert.equal(check(r,'observation_visible').state,'unknown');
  assert.equal(check(r,'subject_position').state,'unknown');
  assert.equal(r.zoomAdvice,null);
  assert.notEqual(r.status,'geometry-consistent');
});

test('raw whole-body clipping is a framing problem, never a valid size estimate',()=>{
  const r=assessFrameCoordination({...complete,box:{x:.3,y:-.1,width:.3,height:1}});
  assert.equal(check(r,'subject_frame').state,'warn');
  assert.equal(check(r,'subject_size'),undefined);
  assert.equal(r.zoomAdvice,null);
});

test('a zoom request in flight suppresses old subject and background conclusions',()=>{
  const r=assessFrameCoordination({...complete,zoom:{...complete.zoom,pending:true},
    background:{...picture(120,160,(x,y)=>(x+y)%2?255:0),sourceKey:'sample',zoomRevision:2}});
  assert.equal(check(r,'zoom_pending').state,'unknown');
  assert.equal(check(r,'subject_position').state,'unknown');
  assert.equal(check(r,'background_source').state,'unknown');
  assert.equal(r.backgroundMetrics,null);assert.equal(r.zoomAdvice,null);
});

test('source and zoom revisions prevent a previous crop from judging a new composition',()=>{
  for(const provenance of [{sourceKey:'old',zoomRevision:2},{sourceKey:'sample',zoomRevision:1}]){
    const r=assessFrameCoordination({...complete,background:{...picture(),...provenance}});
    assert.equal(check(r,'background_source').state,'unknown');assert.equal(r.backgroundMetrics,null);
  }
});

test('actual high-frequency head background is distinguished from a smooth one',()=>{
  const input={target:{x:.5,y:.9},bodyHeight:.5,aspect:.75,poseId:'easy-angle'};
  const flat=analyzeTargetBackground({...picture(),...input});
  const busy=analyzeTargetBackground({...picture(120,160,(x,y)=>(x+y)%2?255:0),...input});
  assert.ok(flat.backgroundFit>.99);assert.ok(busy.backgroundFit<.2);
  assert.ok(busy.edge>flat.edge&&busy.outlineEdge>flat.outlineEdge);
  assert.equal(busy.semanticLabels,false);assert.equal(busy.depthMeasured,false);assert.equal(busy.groundSafetyAssessed,false);
});

test('transparent pixels are missing evidence and the background input is never mutated',()=>{
  const input=picture(),original=input.pixels.slice();
  analyzeTargetBackground({...input,target:{x:.5,y:.8},bodyHeight:.3,poseId:'easy-angle'});
  assert.deepEqual(input.pixels,original);
  for(let i=3;i<input.pixels.length;i+=4)input.pixels[i]=0;
  assert.equal(analyzeTargetBackground({...input,target:{x:.5,y:.8},bodyHeight:.3,poseId:'easy-angle'}),null);
});

test('head-shoulder occlusion is a bounded box-overlap veto, not segmentation',()=>{
  const input={target:{x:.5,y:.9},bodyHeight:.7,aspect:.75,poseId:'easy-angle'};
  const roi=computePoseFootprint({poseId:input.poseId,x:.5,y:.9,height:.7,aspect:.75}).headShoulders;
  const partial=fraction=>assessTargetBackgroundOcclusion({...input,subjectBox:{...roi,width:roi.width*fraction}});
  assert.equal(partial(.10).occluded,false);
  assert.equal(partial(.60).occluded,true);
  near(partial(.60).overlapRatio,.60);
  assert.equal(partial(1).threshold,BACKGROUND_OCCLUSION_THRESHOLD);
  assert.equal(partial(1).segmentation,false);
  assert.equal(assessTargetBackgroundOcclusion({...input,subjectBox:{x:2,y:2,width:1,height:1}}),null);
  assert.equal(assessTargetBackgroundOcclusion({...input,subjectBox:{...roi,visible:false}}),null);
});

test('a person covering the head region cannot make an unseen patterned background pass',()=>{
  const box={x:.30,y:.08,width:.45,height:.82};
  const pixels=picture(160,214,(x,y)=>{
    const u=(x+.5)/160,v=(y+.5)/214;
    return u>=box.x&&u<box.x+box.width&&v>=box.y&&v<box.y+box.height?150:(x+y)%2?255:0;
  });
  const background={...pixels,sourceKey:'sample',zoomRevision:2};
  const r=assessFrameCoordination({...complete,point:{x:.525,y:.9},box,background});
  assert.equal(check(r,'background_occluded').state,'unknown');
  assert.equal(check(r,'background_occluded').evidence.overlapRatio,1);
  assert.equal(check(r,'background_clutter'),undefined);
  assert.equal(r.backgroundMetrics,null);
  assert.match(check(r,'background_occluded').detail,/人物暂时移开/);
  // A veto must happen before pixel sampling, not merely relabel a score.
  const unreadable={sourceKey:'sample',zoomRevision:2,get pixels(){throw new Error('covered pixels must not be sampled');}};
  assert.equal(assessFrameCoordination({...complete,box,background:unreadable}).backgroundMetrics,null);
});

test('untrusted or absent boxes retain visible-pixel heuristics without claiming hidden background',()=>{
  for(const observationOrigin of ['manual','example']){
    const r=assessFrameCoordination({...complete,observationOrigin,
      background:{...picture(),sourceKey:'sample',zoomRevision:2}});
    assert.equal(check(r,'background_occluded'),undefined);
    assert.equal(check(r,'background_clutter').state,'pass');
    assert.match(check(r,'background_clutter').detail,/仅比较当前可见像素/);
    assert.match(check(r,'background_clutter').detail,/未分离人物和背景/);
    assert.equal(r.backgroundMetrics.visiblePixelsOnly,true);
    assert.equal(r.backgroundMetrics.segmentation,false);
  }
});

test('zoom size advice respects framing and does not crop feet to hit a target percentage',()=>{
  const r=assessFrameCoordination({...complete,target:{...complete.target,height:.6,bodyHeight:.6},
    point:{x:.5,y:.95},box:{x:.4,y:.65,width:.2,height:.3}});
  assert.ok(r.zoomAdvice.desired>r.zoomAdvice.feasible);
  assert.equal(r.zoomAdvice.limitedByFrame,true);
  assert.ok(.5+(.95-.5)*r.zoomAdvice.feasible<=.98000001);
  assert.equal(r.zoomAdvice.estimated,true);
  assert.match(r.zoomAdvice.note,/不.*透视/);
});

test('a face touching any edge has unknown size and cannot produce zoom advice',()=>{
  const target=targetForShot({shot:'close',preset:'center'});
  for(const box of [
    {x:0,y:.4,width:.2,height:.2},{x:.4,y:0,width:.2,height:.2},
    {x:.8,y:.4,width:.2,height:.2},{x:.4,y:.8,width:.2,height:.2},
  ]){
    const r=assessFrameCoordination({shot:'close',target,aspect:.75,poseId:'soft-front',
      point:{x:box.x+box.width/2,y:box.y+box.height/2},box,observedKind:'face',
      zoom:{mode:'photo',value:1,min:1,max:3}});
    assert.equal(check(r,'subject_size').state,'unknown');
    assert.equal(r.zoomAdvice,null,'a finite but clipped face box is not size evidence');
  }
});

test('a body inside the pixel bounds but within the caution margin cannot set a target size',()=>{
  const r=assessFrameCoordination({...complete,point:{x:.5,y:.79},box:{x:.35,y:.01,width:.3,height:.78},
    zoom:{mode:'digital',value:2,min:1,max:6}});
  assert.equal(check(r,'subject_frame').state,'warn');
  assert.equal(r.zoomAdvice,null);
});

test('a near-shot zoom preserves an off-centre face instead of zooming it out of view',()=>{
  const box={x:.1,y:.1,width:.1,height:.12},zoom={mode:'photo',value:1,min:1,max:3};
  const r=assessFrameCoordination({shot:'close',target:targetForShot({shot:'close'}),aspect:.75,
    poseId:'soft-front',point:{x:.15,y:.16},box,observedKind:'face',zoom});
  assert.equal(r.zoomAdvice.limitedByFrame,true);
  assert.ok(r.zoomAdvice.feasible<r.zoomAdvice.desired);
  const factor=r.zoomAdvice.feasible/zoom.value;
  for(const edge of [box.x,box.y,box.x+box.width,box.y+box.height]){
    const scaled=.5+(edge-.5)*factor;
    assert.ok(scaled>=.02-1e-9&&scaled<=.98+1e-9);
  }
  assert.match(r.zoomAdvice.note,/不能仅靠倍率达到目标占比/);
});

test('an empty intersection between zoom range and face framing returns no applicable advice',()=>{
  const r=assessFrameCoordination({shot:'close',target:targetForShot({shot:'close'}),aspect:.75,
    poseId:'soft-front',point:{x:.06,y:.16},box:{x:.01,y:.1,width:.1,height:.12},observedKind:'face',
    zoom:{mode:'photo',value:1,min:1,max:3}});
  assert.equal(check(r,'subject_size').state,'warn');
  assert.equal(r.zoomAdvice,null,'the minimum zoom must not override the face framing limit');
});

test('a measurable central face can receive a useful near-shot size recommendation',()=>{
  const target=targetForShot({shot:'close',preset:'center'});
  const r=assessFrameCoordination({shot:'close',target,aspect:.75,poseId:'soft-front',
    point:{x:.5,y:.5},box:{x:.4,y:.4,width:.2,height:.2},observedKind:'face',
    zoom:{mode:'photo',value:1,min:1,max:3}});
  near(r.zoomAdvice.desired,target.faceHeight/.2);
  near(r.zoomAdvice.feasible,r.zoomAdvice.desired);
  assert.equal(r.zoomAdvice.limitedByFrame,false);
  assert.equal(check(r,'intentional_crop').state,'pass');
});

test('an aligned measured subject does not validate the background it is covering',()=>{
  const r=assessFrameCoordination({...complete,background:{...picture(),sourceKey:'sample',zoomRevision:2}});
  assert.equal(r.status,'reference-only');assert.equal(r.artisticScore,null);
  assert.equal(check(r,'subject_size').state,'pass');assert.equal(check(r,'background_occluded').state,'unknown');
  assert.equal(r.backgroundMetrics,null);
});

test('invalid geometry fails explicitly rather than leaking NaN through the UI',()=>{
  assert.equal(computePoseFootprint({poseId:'easy-angle',x:.5,y:.8,height:.5,aspect:0}),null);
  assert.equal(assessFrameCoordination({...complete,aspect:0}).status,'reference-only');
  assert.equal(assessFrameCoordination({...complete,target:{x:NaN,y:.5}}).primary.code,'invalid_target');
});
