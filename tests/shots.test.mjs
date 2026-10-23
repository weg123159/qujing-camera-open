import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOTS, SHOT_TEMPLATE_COORDINATES, targetForShot, getShotTemplateTransform, assessShotComposition } from '../dist/shots.mjs';

const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≈ ${expected}`);
const faceBoxAt = (point, height) => ({ x: point.x - height * 0.32, y: point.y - height / 2, width: height * 0.64, height });

test('shot sizes are seven independent entries with different visible-body crops', () => {
  assert.deepEqual(SHOTS.map((s) => s.id), ['extreme_wide', 'wide', 'full', 'medium_full', 'medium', 'close', 'detail']);
  assert.deepEqual(SHOTS.map((s) => s.name), ['大远景', '远景', '全景', '中全景', '中景', '近景', '特写']);
  assert.deepEqual(SHOTS.slice(0, 3).map((s) => s.kind), ['person', 'person', 'person']);
  assert.deepEqual(SHOTS.slice(3).map((s) => s.kind), ['face', 'face', 'face', 'face']);
  assert.deepEqual(SHOTS.slice(3).map((s) => s.cutAt), ['knees', 'waist', 'chest', 'face']);
  assert.ok(SHOTS[3].referenceVisibleBody.bottom > SHOTS[4].referenceVisibleBody.bottom);
  assert.ok(SHOTS[4].referenceVisibleBody.bottom > SHOTS[5].referenceVisibleBody.bottom);
  for (const shot of SHOTS) assert.ok(shot.description && shot.cropHint);
});

test('composition side and shot size remain independent controls', () => {
  for (const shot of SHOTS) {
    const left = targetForShot({ shot, preset: 'thirds', side: 'left' });
    const right = targetForShot({ shot, preset: 'thirds', side: 'right' });
    near(left.x, 1 / 3); near(right.x, 2 / 3);
    assert.equal(left.height, right.height);
    assert.equal(left.anchor, shot.anchor);
  }
  assert.ok(targetForShot({ shot: 'full' }).bodyHeight > targetForShot({ shot: 'wide' }).bodyHeight);
  assert.ok(targetForShot({ shot: 'wide' }).bodyHeight > targetForShot({ shot: 'extreme_wide' }).bodyHeight);
});

test('manual targets preserve anchor type and may override the body height', () => {
  const manual = { x: 0.4, y: 0.8, height: 0.35, kind: 'person', anchor: 'feet' };
  const result = targetForShot({ shot: 'wide', manualTarget: manual });
  assert.equal(result.x, 0.4); assert.equal(result.y, 0.8); assert.equal(result.bodyHeight, 0.35);
  const ignored = targetForShot({ shot: 'medium', manualTarget: manual });
  assert.equal(ignored.kind, 'face');
  assert.notEqual(ignored.y, manual.y);
  const faceManual = targetForShot({ shot: 'medium', manualTarget: { x: 0.42, y: 0.27, kind: 'face', anchor: 'face' } });
  assert.equal(faceManual.x, 0.42); assert.equal(faceManual.y, 0.27);
});

test('the full SVG foot and face anchors map exactly onto their target', () => {
  for (const shot of SHOTS) {
    const target = targetForShot({ shot });
    const transform = getShotTemplateTransform({ shot, target, aspect: 0.75 });
    near(transform.left + transform.width * 100 / 200, target.x, `${shot.id} horizontal anchor`);
    const svgY = shot.anchor === 'feet' ? 480 : 45;
    near(transform.top + transform.height * svgY / 500, target.y, `${shot.id} vertical anchor`);
  }
});

test('tighter templates really crop at the selected body region and exclude the feet', () => {
  for (const shot of SHOTS.slice(3)) {
    const transform = getShotTemplateTransform({ shot });
    const canonicalHead = transform.translateY;
    const cropLine = transform.translateY + shot.referenceVisibleBody.bottom * transform.scaleY;
    const feet = transform.translateY + transform.scaleY;
    near(canonicalHead, 0.07, `${shot.id} head margin`);
    near(cropLine, 0.99, `${shot.id} cut line`);
    assert.ok(feet > 1, `${shot.id} intentionally excludes feet`);
  }
});

test('body height adjustment changes the whole-body template without moving its feet', () => {
  const target = targetForShot({ shot: 'wide' });
  target.bodyHeight = target.height = 0.4;
  const transform = getShotTemplateTransform({ shot: 'wide', target, aspect: 1.5 });
  near(transform.scaleY, 0.4);
  near(transform.width, 200 / 470 * 0.4 / 1.5);
  near(transform.top + transform.height * 480 / 500, target.y);
  assert.equal(SHOT_TEMPLATE_COORDINATES.bodySpan, 470);
});

test('the face template never infers a different body size from a stray bodyHeight override', () => {
  const target = targetForShot({ shot: 'medium' });
  const normal = getShotTemplateTransform({ shot: 'medium', target });
  const altered = getShotTemplateTransform({ shot: 'medium', target: { ...target, bodyHeight: 0.8, height: 0.8 } });
  near(altered.scaleY, normal.scaleY);
  assert.equal(getShotTemplateTransform({ shot: 'medium', aspect: 0 }), null);
});

test('medium and close shots do not apply full-person completeness checks to valid faces', () => {
  for (const shot of SHOTS.slice(3)) {
    const target = targetForShot({ shot, preset: 'center' });
    const result = assessShotComposition({ shot, point: target, box: faceBoxAt(target, shot.faceHeight), target });
    assert.equal(result.status, 'aligned');
    assert.equal(result.action, null);
    assert.equal(result.score, 100);
    assert.equal(result.sizeAligned, true);
    assert.match(result.measurementNote, /不能由脸框/);
    assert.doesNotMatch(result.title, /完整入镜|头脚/);
  }
});

test('an intentional close-up with an edge-clipped face may align its reference point but makes no size claim', () => {
  const target = { x: 0.5, y: 0.4 };
  const result = assessShotComposition({ shot: 'close', point: target, box: { x: 0.2, y: -0.02, width: 0.6, height: 0.9 }, target });
  assert.notEqual(result.action, 'framing');
  assert.equal(result.score, 100);
  assert.equal(result.sizeAligned, null);
  assert.equal(result.heightRatio, null);
  assert.match(result.detail, /暂不判断大小/);
});

test('whole-body shots still preserve genuine out-of-frame warnings', () => {
  const result = assessShotComposition({ shot: 'full', box: { x: 0.4, y: 0.6, width: 0.2, height: 0.5 } });
  assert.equal(result.action, 'framing');
  assert.equal(result.score, null);
});

test('camera, person and static-photo movements refer to the correct actor', () => {
  const target = targetForShot({ shot: 'medium', preset: 'center' });
  const input = { shot: 'medium', point: { x: 0.7, y: target.y }, target };
  assert.equal(assessShotComposition({ ...input, actor: 'camera', sourceMode: 'camera' }).direction, 'right');
  assert.equal(assessShotComposition({ ...input, actor: 'camera', sourceMode: 'camera', mirrored: true }).direction, 'left');
  assert.equal(assessShotComposition({ ...input, actor: 'person', sourceMode: 'camera' }).direction, 'left');
  assert.equal(assessShotComposition({ ...input, actor: 'camera', sourceMode: 'photo' }).direction, 'left');
  assert.match(assessShotComposition({ ...input, actor: 'camera', sourceMode: 'photo' }).title, /画面/);
});

test('face size changes the size recommendation without changing the positional score', () => {
  const target = targetForShot({ shot: 'medium', preset: 'center' });
  const result = assessShotComposition({ shot: 'medium', point: target, box: faceBoxAt(target, 0.07), target });
  assert.equal(result.score, 100);
  assert.equal(result.action, 'size');
  assert.equal(result.sizeAligned, false);
  assert.match(result.detail, /脸部约占画面高度/);
  assert.match(result.detail, /腰部裁切仍需/);
});

test('missing or invalid observations never produce shot scores or body-size estimates', () => {
  for (const shot of SHOTS) {
    const result = assessShotComposition({ shot });
    assert.equal(result.status, 'waiting');
    assert.equal(result.score, null);
    assert.equal(result.heightRatio, null);
  }
  const target = targetForShot({ shot: 'medium' });
  const manual = assessShotComposition({ shot: 'medium', point: target, target });
  assert.equal(manual.score, 100);
  assert.equal(manual.sizeAligned, null);
  assert.match(manual.detail, /没有脸框时不判断大小/);
});
