import test from 'node:test';
import assert from 'node:assert/strict';
import { planStandingPositions, personFootprint } from '../dist/planner.mjs';
import { getShotTemplateTransform } from '../dist/shots.mjs';
import { assessTargetBackgroundOcclusion } from '../dist/composition-engine.mjs';

function picture(width = 120, height = 120, valueAt = () => 150) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const value = valueAt(x, y);
    pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }
  return { pixels, width, height };
}
const defaults = { region: { x: 0.2, y: 0.68, w: 0.6, h: 0.22 }, target: { x: 0.6, y: 0.8 }, bodyHeight: 0.3 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test('all proposed foot points are inside the user-selected region and full outlines remain in frame', () => {
  const region = { x: 0.17, y: 0.62, w: 0.58, h: 0.2 };
  const input = { ...picture(120, 160), ...defaults, region };
  const result = planStandingPositions(input);
  assert.equal(result.diagnostics.code, 'ok');
  assert.equal(result.candidates.length, 3);
  for (const candidate of result.candidates) {
    assert.ok(candidate.x >= region.x && candidate.x <= region.x + region.w);
    assert.ok(candidate.y >= region.y && candidate.y <= region.y + region.h);
    const box = personFootprint({ ...candidate, aspect: 120 / 160 });
    assert.ok(box.x >= 0.019999 && box.y >= 0.019999);
    assert.ok(box.x + box.width <= 0.980001 && box.y + box.height <= 0.980001);
    assert.equal(candidate.height, input.bodyHeight);
  }
});

test('a smooth background chooses the composition target when it is feasible', () => {
  const { candidates } = planStandingPositions({ ...picture(), ...defaults });
  near(candidates[0].x, defaults.target.x);
  near(candidates[0].y, defaults.target.y);
  assert.equal(candidates[0].score, 100);
});

test('a simpler head-and-shoulder background can outrank the nearest busy target', () => {
  const input = picture(160, 160, (x, y) => x < 86 ? ((x + y) % 2 ? 255 : 0) : 150);
  const result = planStandingPositions({ ...input, ...defaults, target: { x: 0.28, y: 0.8 } });
  assert.equal(result.diagnostics.code, 'ok');
  assert.ok(result.candidates[0].x > 0.55, `Best candidate x=${result.candidates[0].x} should avoid the busy left background.`);
  assert.match(result.candidates[0].reason, /边缘和明暗变化较少/);
});

test('texture below the prospective feet is not misclassified as head-background clutter', () => {
  const region = { x: 0.2, y: 0.79, w: 0.6, h: 0.02 };
  const flat = planStandingPositions({ ...picture(), ...defaults, region });
  const floorTexture = picture(120, 120, (x, y) => y > 100 ? ((x + y) % 2 ? 255 : 0) : 150);
  const textured = planStandingPositions({ ...floorTexture, ...defaults, region });
  assert.deepEqual(textured.candidates, flat.candidates);
});

test('no candidates escape an impossible region merely to produce a recommendation', () => {
  const result = planStandingPositions({ ...picture(), ...defaults, region: { x: 0.2, y: 0.03, w: 0.5, h: 0.1 }, bodyHeight: 0.4 });
  assert.equal(result.diagnostics.code, 'no_space');
  assert.deepEqual(result.candidates, []);
});

test('partly off-frame regions are intersected with the frame without moving candidates outside the original selection', () => {
  const region = { x: -0.2, y: 0.7, w: 0.6, h: 0.5 };
  const result = planStandingPositions({ ...picture(), ...defaults, region });
  assert.ok(result.candidates.length > 0);
  for (const c of result.candidates) {
    assert.ok(c.x >= region.x && c.x <= region.x + region.w);
    assert.ok(c.y >= region.y && c.y <= region.y + region.h);
    assert.ok(c.y <= 0.98);
  }
  assert.equal(planStandingPositions({ ...picture(), ...defaults, region: { x: 1.1, y: 0.7, w: 0.2, h: 0.2 } }).diagnostics.code, 'no_space');
});

test('actual aspect ratio changes whether an entire person fits near the side', () => {
  const input = { ...picture(80, 160), ...defaults, bodyHeight: 0.5, region: { x: 0.08, y: 0.7, w: 0.07, h: 0.2 } };
  assert.equal(planStandingPositions(input).diagnostics.code, 'no_space');
  const wide = planStandingPositions({ ...input, aspect: 2 });
  assert.ok(wide.candidates.length > 0);
  assert.equal(wide.diagnostics.aspect, 2);
  near(personFootprint({ x: 0.5, y: 0.8, height: 0.5, aspect: 2 }).width, 0.105);
});

test('alternative positions are spatially distinct and the planner may return fewer than requested', () => {
  const result = planStandingPositions({ ...picture(), ...defaults });
  for (let i = 0; i < result.candidates.length; i++) for (let j = i + 1; j < result.candidates.length; j++) {
    const a = result.candidates[i], b = result.candidates[j];
    assert.ok(Math.hypot((a.x - b.x) * 120, (a.y - b.y) * 120) >= 10.8 - 1e-9);
  }
  const tiny = planStandingPositions({ ...picture(), ...defaults, region: { x: 0.5, y: 0.8, w: 0.005, h: 0.005 } });
  assert.equal(tiny.candidates.length, 1);
});

test('transparent image areas do not produce invented background scores', () => {
  const transparent = picture();
  for (let i = 3; i < transparent.pixels.length; i += 4) transparent.pixels[i] = 0;
  const result = planStandingPositions({ ...transparent, ...defaults });
  assert.equal(result.diagnostics.code, 'no_background_samples');
  assert.deepEqual(result.candidates, []);
});

test('invalid pixels, bounds, targets, scale, and requested counts return explicit empty results', () => {
  const base = { ...picture(), ...defaults };
  assert.equal(planStandingPositions({ ...base, pixels: new Uint8ClampedArray(4) }).diagnostics.code, 'invalid_image');
  assert.equal(planStandingPositions({ ...base, region: { x: 0, y: 0, w: 0, h: 1 } }).diagnostics.code, 'invalid_region');
  assert.equal(planStandingPositions({ ...base, target: { x: NaN, y: 0.5 } }).diagnostics.code, 'invalid_target');
  assert.equal(planStandingPositions({ ...base, bodyHeight: 1 }).diagnostics.code, 'invalid_height');
  assert.equal(planStandingPositions({ ...base, aspect: 0 }).diagnostics.code, 'invalid_aspect');
  assert.equal(planStandingPositions({ ...base, limit: 0 }).diagnostics.code, 'empty_limit');
});

test('analysis is deterministic, does not modify the image, and does not claim terrain safety', () => {
  const input = { ...picture(), ...defaults };
  const original = input.pixels.slice();
  const first = planStandingPositions(input);
  assert.deepEqual(first, planStandingPositions(input));
  assert.deepEqual(input.pixels, original);
  assert.match(first.diagnostics.message, /不判断地面是否可站立/);
});

test('the same person height can fit a narrow pose but not an extended-arm pose', () => {
  const input = {
    ...picture(120, 160), ...defaults, bodyHeight: 0.7,
    region: { x: 0.12, y: 0.8, w: 0.02, h: 0.1 }, target: { x: 0.13, y: 0.85 },
  };
  const narrow = planStandingPositions({ ...input, poseId: 'easy-angle' });
  const wide = planStandingPositions({ ...input, poseId: 'open-view' });
  assert.equal(narrow.diagnostics.code, 'ok');
  assert.equal(wide.diagnostics.code, 'no_space');
  assert.ok(wide.diagnostics.bodyWidth > narrow.diagnostics.bodyWidth * 1.4);
  for (const c of narrow.candidates) {
    assert.ok(c.footprint.x >= 0.02 - 1e-9);
    assert.ok(c.footprint.x + c.footprint.width <= 0.98 + 1e-9);
    assert.equal(c.height, input.bodyHeight, 'planner must not secretly shrink the pose to fit');
  }
});

test('mirroring an asymmetric pose swaps the margins required at the sides', () => {
  const input = {
    ...picture(120, 160), ...defaults, bodyHeight: 0.7, poseId: 'easy-angle',
    region: { x: 0.12, y: 0.8, w: 0.02, h: 0.1 }, target: { x: 0.13, y: 0.85 },
  };
  const regular = planStandingPositions(input);
  const mirrored = planStandingPositions({ ...input, poseMirrored: true });
  assert.equal(regular.diagnostics.code, 'ok');
  assert.equal(mirrored.diagnostics.code, 'no_space');
  near(regular.diagnostics.footprintExtent.left, mirrored.diagnostics.footprintExtent.right);
  near(regular.diagnostics.footprintExtent.right, mirrored.diagnostics.footprintExtent.left);
});

test('candidate templates use the same view transform and retain source, zoom and pose provenance', () => {
  const input = { ...picture(120, 160), ...defaults, poseId: 'open-view', poseMirrored: true, sourceKey: 'camera:7', zoomRevision: 12 };
  const result = planStandingPositions(input);
  assert.equal(result.diagnostics.code, 'ok');
  assert.equal(result.diagnostics.sourceKey, input.sourceKey);
  assert.equal(result.diagnostics.zoomRevision, 12);
  for (const c of result.candidates) {
    const transform = getShotTemplateTransform({ shot: 'wide', target: { ...c, bodyHeight: c.height }, aspect: 0.75 });
    for (const property of ['left', 'top', 'width', 'height']) near(c.template[property], transform[property]);
    assert.deepEqual(c.provenance, { sourceKey: input.sourceKey, zoomRevision: 12, poseId: input.poseId, poseMirrored: true });
    assert.equal(c.metrics.semanticLabels, false);
    assert.equal(c.metrics.depthMeasured, false);
    assert.equal(c.metrics.groundSafetyAssessed, false);
    assert.match(c.metrics.method, /pose-head-shoulder/);
  }
  assert.equal(result.diagnostics.rankingOnly, true);
});

test('unsettled zoom and invalid pose geometry do not yield invented recommendations', () => {
  const input = { ...picture(), ...defaults, poseId: 'easy-angle' };
  for (const [extra, expected] of [
    [{ zoomPending: true }, 'zoom_pending'],
    [{ poseId: 'missing-pose' }, 'invalid_pose'],
  ]) {
    const result = planStandingPositions({ ...input, ...extra });
    assert.equal(result.diagnostics.code, expected);
    assert.deepEqual(result.candidates, []);
  }
});

test('a foreground person covering every candidate prevents background rankings', () => {
  const input={...picture(),...defaults,poseId:'easy-angle',subjectBox:{x:0,y:0,width:1,height:1}};
  const result=planStandingPositions(input);
  assert.equal(result.diagnostics.code,'background_occluded');
  assert.deepEqual(result.candidates,[]);
  assert.equal(result.diagnostics.rejectedForOcclusion,result.diagnostics.sampledCandidates);
  assert.equal(result.diagnostics.rejectedForTransparency,0);
  assert.equal(result.diagnostics.subjectOcclusionAvailable,true);
  assert.match(result.diagnostics.message,/人物暂时移开/);
});

test('planner skips covered head regions while retaining alternatives outside the person box', () => {
  const subjectBox={x:.1,y:.35,width:.35,height:.6};
  const input={...picture(),...defaults,poseId:'easy-angle',subjectBox,target:{x:.28,y:.8}};
  const original={...subjectBox};
  const result=planStandingPositions(input);
  assert.equal(result.diagnostics.code,'ok');
  assert.ok(result.diagnostics.rejectedForOcclusion>0);
  assert.ok(result.candidates.length>0);
  for(const c of result.candidates){
    const evidence=assessTargetBackgroundOcclusion({subjectBox,target:c,bodyHeight:c.height,aspect:1,poseId:input.poseId});
    assert.equal(evidence.occluded,false);
    assert.ok(c.metrics.occlusion.overlapRatio<c.metrics.occlusion.threshold);
    assert.match(c.reason,/当前头肩区域的可见像素/);
  }
  assert.deepEqual(subjectBox,original);
  assert.match(result.diagnostics.message,/已跳过被现有人物明显遮挡/);
});

test('missing or invalid subject boxes preserve legacy heuristics with explicit visible-pixel scope', () => {
  const input={...picture(),...defaults,poseId:'easy-angle'};
  const noBox=planStandingPositions(input);
  for(const subjectBox of [null,{x:NaN,y:0,width:1,height:1},{x:0,y:0,width:1,height:1,visible:false}]){
    const result=planStandingPositions({...input,subjectBox});
    assert.deepEqual(result.candidates,noBox.candidates);
    assert.equal(result.diagnostics.subjectOcclusionAvailable,false);
    assert.equal(result.diagnostics.visiblePixelsOnly,true);
    assert.equal(result.diagnostics.rejectedForOcclusion,0);
    assert.match(result.diagnostics.message,/未做人物分割/);
  }
});
