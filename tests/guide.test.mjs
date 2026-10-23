import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getCoverCrop, sourcePointToView, sourceBoxToView, targetFor, assessComposition, assessBodyComposition } from '../dist/guide.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
const target = { x: 0.5, y: 0.4 };

test('cover crop uses the centered source rectangle for portrait and landscape viewfinders', () => {
  assert.deepEqual(getCoverCrop(1920, 1080, 300, 400), { sx: 555, sy: 0, sw: 810, sh: 1080 });
  assert.deepEqual(getCoverCrop(1080, 1920, 400, 300), { sx: 0, sy: 555, sw: 1080, sh: 810 });
  assert.deepEqual(getCoverCrop(1600, 1200, 800, 600), { sx: 0, sy: 0, sw: 1600, sh: 1200 });
});

test('cover crop rejects unavailable or invalid frame dimensions', () => {
  for (const invalid of [0, -1, NaN, Infinity, undefined]) {
    assert.throws(() => getCoverCrop(invalid, 1080, 300, 400), RangeError);
  }
});

test('point mapping applies the same crop as the camera image', () => {
  const result = sourcePointToView({ x: 555 / 1920, y: 0.25 }, 1920, 1080, 300, 400);
  near(result.x, 0);
  near(result.y, 0.25);
  assert.equal(result.visible, true);
  const middle = sourcePointToView({ x: 0.5, y: 0.5 }, 1920, 1080, 300, 400);
  assert.deepEqual(middle, { x: 0.5, y: 0.5, visible: true });
});

test('mirror happens after crop and preserves vertical position', () => {
  const point = { x: 0.6, y: 0.3 };
  const normal = sourcePointToView(point, 1920, 1080, 300, 400, false);
  const selfie = sourcePointToView(point, 1920, 1080, 300, 400, true);
  near(selfie.x, 1 - normal.x);
  near(selfie.y, normal.y);
  assert.equal(selfie.visible, normal.visible);
});

test('cropped-away source point is invisible instead of clamped to an edge', () => {
  const point = sourcePointToView({ x: 0.1, y: 0.5 }, 1920, 1080, 300, 400);
  assert.equal(point.visible, false);
  assert.ok(point.x < 0);
  assert.equal(assessComposition({ point, target }).status, 'waiting');
});

test('invalid source points and unloaded video return an invisible point', () => {
  for (const point of [null, {}, { x: NaN, y: 0.5 }, { x: 0.5, y: Infinity }, { x: -0.01, y: 0.5 }]) {
    assert.equal(sourcePointToView(point, 1920, 1080, 300, 400).visible, false);
  }
  assert.equal(sourcePointToView({ x: 0.5, y: 0.5 }, 0, 0, 300, 400).visible, false);
});

test('box transformation preserves out-of-source bounds for the framing check', () => {
  const raw = { x: -0.05, y: 0.75, width: 0.2, height: 0.35 };
  const mapped = sourceBoxToView(raw, 1200, 1600, 300, 400);
  assert.deepEqual(mapped, raw);
  assert.ok(mapped.y + mapped.height > 1);
  const result = assessBodyComposition({ box: mapped, target: { x: 0.5, y: 0.8 } });
  assert.equal(result.action, 'framing');
  assert.equal(result.score, null);
});

test('whole-box mirroring follows cover crop and an explicit static pan/zoom crop', () => {
  const raw = { x: 0.2, y: 0.25, width: 0.4, height: 0.5 };
  const normal = sourceBoxToView(raw, 1920, 1080, 300, 400);
  const mirrored = sourceBoxToView(raw, 1920, 1080, 300, 400, true);
  near(normal.x, (384 - 555) / 810);
  near(normal.width, 768 / 810);
  near(mirrored.x, 1 - normal.x - normal.width);
  near(mirrored.y, normal.y);
  near(mirrored.width, normal.width);
  near(mirrored.height, normal.height);
  const crop = { sx: 400, sy: 200, sw: 600, sh: 800 };
  const staticBox = sourceBoxToView({ x: 0.4, y: 0.2, width: 0.2, height: 0.3 }, 1200, 1600, 300, 400, true, crop);
  near(staticBox.x, 1 - (480 - 400) / 600 - 240 / 600);
  near(staticBox.y, (320 - 200) / 800);
  near(staticBox.width, 240 / 600);
  near(staticBox.height, 480 / 800);
});

test('box transformation rejects malformed data, unavailable dimensions, and invalid crops', () => {
  const box = { x: 0.4, y: 0.2, width: 0.2, height: 0.3 };
  for (const invalid of [null, {}, { ...box, x: NaN }, { ...box, width: 0 }, { ...box, height: -1 }]) {
    assert.equal(sourceBoxToView(invalid, 1200, 1600, 300, 400), null);
  }
  assert.equal(sourceBoxToView(box, 0, 1600, 300, 400), null);
  assert.equal(sourceBoxToView(box, 1200, 1600, Infinity, 400), null);
  assert.equal(sourceBoxToView(box, 1200, 1600, 300, 400, false, { sx: 0, sy: 0, sw: 0, sh: 400 }), null);
  assert.equal(sourceBoxToView(box, 1200, 1600, 300, 400, false, { sx: NaN, sy: 0, sw: 300, sh: 400 }), null);
});

test('preset targets and side switching have exact specified positions', () => {
  assert.deepEqual(targetFor('thirds'), { x: 2 / 3, y: 1 / 3, label: '三分法' });
  assert.deepEqual(targetFor('thirds', 'left'), { x: 1 / 3, y: 1 / 3, label: '三分法' });
  assert.deepEqual(targetFor('center'), { x: 0.5, y: 0.4, label: '居中构图' });
  assert.equal(targetFor('center', 'left').x, 0.5);
  assert.equal(targetFor('negative', 'left').x, 0.27);
  assert.equal(targetFor('negative', 'right').x, 0.73);
});

test('rear-camera guidance chooses the movement that brings the subject toward the target', () => {
  assert.equal(assessComposition({ point: { x: 0.8, y: 0.4 }, target }).direction, 'right');
  assert.equal(assessComposition({ point: { x: 0.2, y: 0.4 }, target }).direction, 'left');
  assert.equal(assessComposition({ point: { x: 0.5, y: 0.8 }, target }).direction, 'down');
  assert.equal(assessComposition({ point: { x: 0.5, y: 0.1 }, target }).direction, 'up');
});

test('selfie guidance flips horizontal movements but not vertical movements', () => {
  assert.equal(assessComposition({ point: { x: 0.8, y: 0.4 }, target, mirrored: true }).direction, 'left');
  assert.equal(assessComposition({ point: { x: 0.2, y: 0.4 }, target, mirrored: true }).direction, 'right');
  assert.equal(assessComposition({ point: { x: 0.5, y: 0.8 }, target, mirrored: true }).direction, 'down');
  assert.equal(assessComposition({ point: { x: 0.5, y: 0.1 }, target, mirrored: true }).direction, 'up');
});

test('the larger normalized axis discrepancy determines one clear movement', () => {
  assert.equal(assessComposition({ point: { x: 0.6, y: 0.8 }, target }).direction, 'down');
  assert.equal(assessComposition({ point: { x: 0.8, y: 0.5 }, target }).direction, 'right');
});

test('alignment tolerance applies to both axes and does not require fabricated stability', () => {
  assert.equal(assessComposition({ point: { x: 0.54, y: 0.44 }, target, steadyMs: 0 }).status, 'aligned');
  assert.equal(assessComposition({ point: { x: 0.546, y: 0.4 }, target, steadyMs: 9999 }).status, 'adjusting');
  assert.equal(assessComposition({ point: target, target }).score, 100);
  assert.equal(assessComposition({ point: target, target }).direction, null);
});

test('invalid, absent, or invisible subjects produce no numerical score or movement', () => {
  for (const point of [null, undefined, {}, { x: 0.5, y: NaN }, { x: 2, y: 0.4 }, { x: 0.5, y: 0.4, visible: false }]) {
    const result = assessComposition({ point, target });
    assert.equal(result.status, 'waiting');
    assert.equal(result.score, null);
    assert.equal(result.direction, null);
    assert.equal(result.distance, null);
  }
});

test('invalid targets are waiting and valid positional scores stay within 0..100', () => {
  assert.equal(assessComposition({ point: target, target: null }).status, 'waiting');
  assert.equal(assessComposition().score, null);
  for (const point of [{ x: 0, y: 0 }, { x: 1, y: 1 }, target]) {
    const result = assessComposition({ point, target });
    assert.ok(result.score >= 0 && result.score <= 100);
  }
});

test('nine preset entries have unique ids and valid user-facing metadata', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['thirds', 'center', 'negative', 'golden', 'symmetry', 'diagonal', 'leading', 'frame', 'wide']);
  for (const preset of PRESETS) {
    assert.ok(preset.name && preset.subtitle && preset.description);
    assert.ok(preset.defaultHeight > 0 && preset.defaultHeight < 1);
    for (const side of ['left', 'right']) {
      const foot = targetFor(preset.id, side, 'person', preset.defaultHeight);
      assert.ok(foot.x > 0 && foot.x < 1 && foot.y < 1);
      assert.ok(foot.y - foot.height >= 0.05, `${preset.id} leaves headroom`);
    }
  }
});

test('wide person target defaults to 20% height and allows an explicit override', () => {
  assert.equal(targetFor('wide', 'right', 'person').height, 0.2);
  assert.equal(targetFor('wide', 'right', 'person', 0.35).height, 0.35);
  assert.equal(targetFor('thirds', 'right', 'person').height, 0.3);
  assert.ok(targetFor('negative', 'right', 'person', 0.85).y - 0.85 >= 0.05);
});

const footTarget = { x: 0.5, y: 0.8, height: 0.3 };
const bodyAt = (x = 0.5, y = 0.8, height = 0.3) => ({ x: x - 0.07, y: y - height, width: 0.14, height });

test('body guidance distinguishes camera movement from movement within the picture', () => {
  const input = { point: { x: 0.7, y: 0.8 }, box: bodyAt(0.7), target: footTarget, desiredHeight: 0.3 };
  assert.equal(assessBodyComposition({ ...input, actor: 'camera' }).direction, 'right');
  assert.equal(assessBodyComposition({ ...input, actor: 'person' }).direction, 'left');
  assert.equal(assessBodyComposition({ ...input, actor: 'camera', mirrored: true }).direction, 'left');
  assert.equal(assessBodyComposition({ ...input, actor: 'person', mirrored: true }).direction, 'left');
  assert.match(assessBodyComposition({ ...input, actor: 'person' }).title, /画面/);
});

test('body vertical guidance is about the visible foot point, not inferred ground distance', () => {
  const input = { point: { x: 0.5, y: 0.6 }, box: bodyAt(0.5, 0.6), target: footTarget };
  assert.equal(assessBodyComposition({ ...input, actor: 'camera' }).direction, 'up');
  assert.equal(assessBodyComposition({ ...input, actor: 'person' }).direction, 'down');
  assert.match(assessBodyComposition({ ...input, actor: 'person' }).detail, /不代表实际地面路线/);
});

test('body size fit is separate from position score', () => {
  const input = { point: footTarget, box: bodyAt(0.5, 0.8, 0.6), target: footTarget, desiredHeight: 0.3 };
  const result = assessBodyComposition(input);
  assert.equal(result.score, 100);
  assert.equal(result.positionAligned, true);
  assert.equal(result.sizeAligned, false);
  assert.equal(result.status, 'adjusting');
  assert.equal(result.action, 'size');
  assert.equal(result.direction, null);
  assert.match(result.title, /拉远/);
  assert.match(assessBodyComposition({ ...input, actor: 'person' }).title, /离镜头远/);
  assert.match(assessBodyComposition({ ...input, box: bodyAt(0.5, 0.8, 0.1) }).title, /拉近/);
});

test('body box bottom center may be used as an explicitly approximate foot point', () => {
  const result = assessBodyComposition({ box: bodyAt(), target: footTarget });
  assert.equal(result.status, 'aligned');
  assert.equal(result.score, 100);
  assert.equal(result.approximate, true);
  assert.equal(result.heightRatio, 0.3);
});

test('missing body evidence and points outside the view do not produce fabricated scores', () => {
  assert.equal(assessBodyComposition({ target: footTarget }).score, null);
  assert.equal(assessBodyComposition({ point: { x: 0.5, y: 0.8, visible: false }, box: bodyAt(), target: footTarget }).score, null);
  assert.equal(assessBodyComposition({ point: footTarget, target: null }).score, null);
  const manual = assessBodyComposition({ point: footTarget, target: footTarget });
  assert.equal(manual.score, 100);
  assert.equal(manual.sizeAligned, null);
  assert.equal(manual.heightRatio, null);
  assert.match(manual.detail, /尚未评估人物大小/);
});

test('clipped body bounds are not treated as a complete person', () => {
  const result = assessBodyComposition({ point: { x: 0.05, y: 0.8 }, box: { x: -0.02, y: 0.5, width: 0.14, height: 0.3 }, target: footTarget });
  assert.equal(result.status, 'adjusting');
  assert.equal(result.action, 'framing');
  assert.equal(result.score, null);
  assert.equal(result.heightRatio, null);
});

test('a box extending below the frame reports framing even when its foot point is absent or invisible', () => {
  const box = { x: 0.4, y: 0.75, width: 0.2, height: 0.35 };
  for (const point of [undefined, { x: 0.5, y: 1.1, visible: false }, { x: 0.5, y: 1.1 }]) {
    const result = assessBodyComposition({ point, box, target: footTarget });
    assert.equal(result.status, 'adjusting');
    assert.equal(result.action, 'framing');
    assert.equal(result.score, null);
    assert.equal(result.heightRatio, null);
    assert.match(result.title, /完整入镜/);
  }
});

test('boxes touching the top or bottom never claim the whole person is suitably framed', () => {
  const cases = [
    { box: { x: 0.4, y: 0, width: 0.2, height: 0.8 }, point: { x: 0.5, y: 0.8 } },
    { box: { x: 0.4, y: 0.65, width: 0.2, height: 0.35 }, point: { x: 0.5, y: 1 } },
  ];
  for (const { box, point } of cases) {
    const result = assessBodyComposition({ point, box, target: point, desiredHeight: box.height });
    assert.equal(result.status, 'adjusting');
    assert.equal(result.action, 'framing');
    assert.equal(result.score, null);
    assert.equal(result.sizeAligned, null);
    assert.match(result.title, /请确认头脚完整/);
    assert.doesNotMatch(result.title, /都合适/);
  }
});

test('the product edge margin is cautious near 1% but permits a 2% head margin', () => {
  const close = { x: 0.4, y: 0.01, width: 0.2, height: 0.79 };
  assert.equal(assessBodyComposition({ point: footTarget, box: close, target: footTarget, desiredHeight: 0.79 }).action, 'framing');
  const inset = { x: 0.4, y: 0.02, width: 0.2, height: 0.78 };
  const result = assessBodyComposition({ point: footTarget, box: inset, target: footTarget, desiredHeight: 0.78 });
  assert.equal(result.status, 'aligned');
  assert.equal(result.score, 100);
});
