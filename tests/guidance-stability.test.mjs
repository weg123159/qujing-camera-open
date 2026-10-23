import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuidanceStabilizer } from '../dist/guidance-stability.mjs';
import { targetForShot } from '../dist/shots.mjs';

const target = { x: 0.5, y: 0.75, height: 0.2, bodyHeight: 0.2 };
const baseInput = { shot: 'wide', target, sourceMode: 'camera', sourceKey: 'rear-1', actor: 'camera' };

function observation(id, at, { x = target.x, y = target.y, height = 0.2, confidence = 0.9, subjectKey = 'person-1', ...extra } = {}) {
  return {
    observationId: id, capturedAtMs: at, point: { x, y },
    box: { x: x - 0.05, y: y - height, width: 0.1, height },
    confidence, subjectKey, expectedIntervalMs: 250, ...extra,
  };
}

function push(filter, id, at, changes = {}, input = {}) {
  return filter.update({ ...baseInput, nowMs: at, observation: observation(id, at, changes), ...input });
}

function confirm(filter) {
  push(filter, 1, 0);
  push(filter, 2, 250);
  return push(filter, 3, 550);
}

test('a green result requires three genuinely new observations and elapsed sample time', () => {
  const filter = createGuidanceStabilizer();
  assert.equal(push(filter, 1, 0).guidance.stable, false);
  assert.equal(push(filter, 2, 250).guidance.status, 'adjusting');
  const result = push(filter, 3, 550);
  assert.equal(result.guidance.status, 'aligned');
  assert.equal(result.guidance.stable, true);
  assert.equal(result.guidance.settling, false);
  assert.equal(result.tracking.sampleCount, 3);
  assert.equal(result.tracking.stableForMs, 550);
  assert.match(result.guidance.title, /持续接近参考/);
});

test('repainting, heartbeat and repeated IDs cannot manufacture continuous evidence', () => {
  const filter = createGuidanceStabilizer();
  const first = observation(1, 0);
  filter.update({ ...baseInput, nowMs: 0, observation: first });
  for (const nowMs of [100, 200, 400, 600]) {
    const result = filter.update({ ...baseInput, nowMs, observation: first });
    assert.equal(result.guidance.stable, false);
    assert.equal(result.tracking.sampleCount, 1);
    assert.equal(result.tracking.stableForMs, 0);
  }
  const heartbeat = filter.update({ ...baseInput, nowMs: 650 });
  assert.equal(heartbeat.guidance.stable, false);
  assert.equal(heartbeat.tracking.sampleCount, 1);
});

test('three very fast samples still need the configured duration', () => {
  const filter = createGuidanceStabilizer();
  for (let i = 0; i < 5; i++) assert.equal(push(filter, i + 1, i * 100).guidance.stable, false);
  assert.equal(push(filter, 6, 500).guidance.stable, true);
});

test('missing and low-confidence observations immediately remove score, point and green state', () => {
  for (const change of [{ point: null, box: null, subjectKey: null }, { confidence: 0.2 }]) {
    const filter = createGuidanceStabilizer();
    assert.equal(confirm(filter).guidance.stable, true);
    const lost = push(filter, 4, 800, change);
    assert.equal(lost.point, null);
    assert.equal(lost.box, null);
    assert.equal(lost.guidance.status, 'waiting');
    assert.equal(lost.guidance.score, null);
    assert.equal(lost.guidance.direction, null);
    assert.equal(lost.guidance.stable, false);
    assert.equal(push(filter, 5, 1050).tracking.sampleCount, 1);
    assert.equal(push(filter, 6, 1300).guidance.stable, false);
  }
});

test('explicit null clears and an older repeated observation cannot resurrect the point', () => {
  const filter = createGuidanceStabilizer();
  push(filter, 1, 0);
  const cleared = filter.update({ ...baseInput, nowMs: 100, observation: null });
  assert.equal(cleared.point, null);
  assert.equal(cleared.guidance.score, null);
  const old = filter.update({ ...baseInput, nowMs: 200, observation: observation(1, 0) });
  assert.equal(old.point, null);
  assert.equal(old.tracking.reason, 'cleared');
  assert.ok(push(filter, 2, 300).point);
});

test('silent detection expires by capture age and slow detection uses its own bounded cadence', () => {
  const filter = createGuidanceStabilizer();
  assert.equal(confirm(filter).guidance.stable, true);
  const fresh = filter.update({ ...baseInput, nowMs: 1200 });
  assert.equal(fresh.guidance.stable, true);
  assert.equal(fresh.tracking.expiresAtMs, 1250);
  const expired = filter.update({ ...baseInput, nowMs: 1251 });
  assert.equal(expired.point, null);
  assert.equal(expired.guidance.score, null);
  assert.equal(expired.tracking.reason, 'expired');

  const slow = createGuidanceStabilizer();
  const initial = slow.update({ ...baseInput, nowMs: 600, observation: observation(1, 0, { expectedIntervalMs: 1800 }) });
  assert.equal(initial.tracking.expiresAtMs, 3800);
  assert.ok(slow.update({ ...baseInput, nowMs: 3700 }).point);
  assert.equal(slow.update({ ...baseInput, nowMs: 3801 }).point, null);

  const late = createGuidanceStabilizer().update({ ...baseInput, nowMs: 2000, observation: observation(1, 0, { expectedIntervalMs: 250 }) });
  assert.equal(late.guidance.score, null);
  assert.equal(late.tracking.reason, 'expired');
});

test('unknown confidence stays unknown while invalid confidence never becomes evidence', () => {
  const unknown = push(createGuidanceStabilizer(), 1, 0, { confidence: null });
  assert.equal(unknown.tracking.confidence, null);
  assert.equal(unknown.guidance.score, 100);
  assert.equal(unknown.guidance.stable, false);
  for (const confidence of [NaN, Infinity, -0.1, 1.1]) {
    const result = push(createGuidanceStabilizer(), 1, 0, { confidence });
    assert.equal(result.point, null);
    assert.equal(result.guidance.score, null);
  }
});

test('short measured jitter is smoothed without inventing points between detections', () => {
  const filter = createGuidanceStabilizer();
  const first = push(filter, 1, 0, { x: 0.55 });
  const second = push(filter, 2, 100, { x: 0.59 });
  assert.equal(first.point.x, 0.55);
  assert.ok(second.point.x > 0.55 && second.point.x < 0.59);
  const repaint = filter.update({ ...baseInput, nowMs: 150 });
  assert.deepEqual(repaint.point, second.point);
  assert.deepEqual(repaint.box, second.box);
});

test('averaging off-target observations across the target never creates aligned evidence', () => {
  const filter = createGuidanceStabilizer({ minAlpha: 0.5, maxAlpha: 0.5, jumpDistance: 0.4 });
  push(filter, 1, 0, { x: 0.44 });
  const averaged = push(filter, 2, 250, { x: 0.56 });
  assert.ok(Math.abs(averaged.point.x - 0.5) < 1e-9);
  assert.equal(averaged.guidance.stable, false);
  assert.equal(averaged.tracking.sampleCount, 0);
  for (let id = 3; id < 10; id++) {
    const result = push(filter, id, (id - 1) * 250, { x: id % 2 ? 0.44 : 0.56 });
    assert.equal(result.guidance.stable, false);
    assert.notEqual(result.guidance.status, 'aligned');
  }
});

test('raw size disagreement cannot be hidden by a matching averaged box', () => {
  const filter = createGuidanceStabilizer({ minAlpha: 0.5, maxAlpha: 0.5 });
  push(filter, 1, 0, { height: 0.16 });
  const result = push(filter, 2, 250, { height: 0.24 });
  assert.ok(Math.abs(result.box.height - 0.2) < 1e-9);
  assert.equal(result.guidance.stable, false);
  assert.equal(result.tracking.sampleCount, 0);
  assert.equal(result.guidance.sizeAligned, false);
});

test('raw off-frame and edge-touching boxes immediately override smoothing and stability', () => {
  for (const box of [
    { x: -0.02, y: 0.55, width: 0.1, height: 0.2 },
    { x: 0.45, y: 0, width: 0.1, height: 0.75 },
    { x: 0.45, y: 0.75, width: 0.1, height: 0.35 },
  ]) {
    const filter = createGuidanceStabilizer();
    confirm(filter);
    const result = push(filter, 4, 800, { box });
    assert.equal(result.guidance.action, 'framing');
    assert.equal(result.guidance.score, null);
    assert.equal(result.guidance.stable, false);
    assert.deepEqual(result.box, box);
  }
});

test('live point-only guidance cannot claim verified size or overall stability', () => {
  const filter = createGuidanceStabilizer();
  let result;
  for (const [index, at] of [0, 250, 550, 800].entries()) result = push(filter, index + 1, at, { box: null });
  assert.equal(result.guidance.score, 100);
  assert.equal(result.guidance.sizeAligned, null);
  assert.equal(result.guidance.stable, false);
  assert.equal(result.guidance.referenceOnly, true);
  assert.match(result.guidance.title, /大小尚未确认/);
});

test('source, subject, kind, mirror and explicit reset never reuse previous confirmation', () => {
  for (const input of [{ sourceKey: 'rear-2' }, { mirrored: true }]) {
    const filter = createGuidanceStabilizer();
    confirm(filter);
    const changed = push(filter, 4, 800, {}, input);
    assert.equal(changed.guidance.stable, false);
    assert.equal(changed.tracking.sampleCount, 1);
  }
  const subject = createGuidanceStabilizer();
  confirm(subject);
  assert.equal(push(subject, 4, 800, { subjectKey: 'person-2' }).tracking.sampleCount, 1);
  subject.reset();
  assert.equal(push(subject, 1, 0).tracking.sampleCount, 1);

  const kind = createGuidanceStabilizer();
  confirm(kind);
  const faceTarget = targetForShot({ shot: 'medium', preset: 'center' });
  const face = kind.update({ ...baseInput, shot: 'medium', target: faceTarget, nowMs: 800,
      observation: { observationId: 4, capturedAtMs: 800, confidence: 0.9, subjectKey: 'face-1',
      point: faceTarget, box: { x: faceTarget.x - 0.06, y: faceTarget.y - faceTarget.faceHeight / 2, width: 0.12, height: faceTarget.faceHeight } } });
  assert.equal(face.guidance.stable, false);
  assert.equal(face.tracking.sampleCount, 1);
});

test('a source or kind change cannot reclassify the old frame ID as a fresh observation', () => {
  const filter = createGuidanceStabilizer();
  confirm(filter);
  const old = observation(3, 550);
  const result = filter.update({ ...baseInput, sourceKey: 'other-camera', nowMs: 600, observation: old });
  assert.equal(result.point, null);
  assert.equal(result.guidance.score, null);
  assert.equal(result.tracking.sampleCount, 0);
  assert.ok(push(filter, 4, 800, {}, { sourceKey: 'other-camera' }).point);
});

test('changing the target clears confirmation without counting an old frame again', () => {
  const filter = createGuidanceStabilizer();
  confirm(filter);
  const result = filter.update({ ...baseInput, target: { ...target, x: 0.51 }, nowMs: 600 });
  assert.equal(result.guidance.stable, false);
  assert.equal(result.tracking.sampleCount, 0);
  assert.equal(result.guidance.settling, true);
});

test('large unlabelled jumps snap to new evidence and reset instead of blending two subjects', () => {
  const filter = createGuidanceStabilizer();
  push(filter, 1, 0, { x: 0.2, subjectKey: null });
  const result = push(filter, 2, 250, { x: 0.8, subjectKey: null });
  assert.equal(result.point.x, 0.8);
  assert.equal(result.guidance.stable, false);
});

test('axis hysteresis keeps a valid command through near ties and adopts persistent dominance', () => {
  const filter = createGuidanceStabilizer({ minAlpha: 1, maxAlpha: 1 });
  assert.equal(push(filter, 1, 0, { x: 0.66, y: 0.9 }).guidance.direction, 'right');
  assert.equal(push(filter, 2, 250, { x: 0.65, y: 0.91 }).guidance.direction, 'right');
  assert.equal(push(filter, 3, 500, { x: 0.56, y: 0.95 }).guidance.direction, 'right');
  assert.equal(push(filter, 4, 750, { x: 0.56, y: 0.95 }).guidance.direction, 'down');
});

test('a sign reversal never continues the old wrong arrow and requires fresh confirmation', () => {
  const filter = createGuidanceStabilizer({ minAlpha: 1, maxAlpha: 1 });
  assert.equal(push(filter, 1, 0, { x: 0.57 }).guidance.direction, 'right');
  const reverse = push(filter, 2, 250, { x: 0.43 });
  assert.equal(reverse.guidance.direction, null);
  assert.equal(reverse.guidance.settling, true);
  assert.equal(filter.update({ ...baseInput, nowMs: 475 }).guidance.direction, null);
  assert.equal(push(filter, 3, 500, { x: 0.43 }).guidance.direction, 'left');
});

test('camera, selfie, person and photo direction conventions survive temporal integration', () => {
  for (const [input, direction] of [
    [{}, 'right'], [{ mirrored: true }, 'left'], [{ actor: 'person' }, 'left'], [{ sourceMode: 'photo' }, 'left'],
  ]) {
    const result = push(createGuidanceStabilizer(), 1, 0, { x: 0.65 }, input);
    assert.equal(result.guidance.direction, direction);
  }
});

test('confirmed alignment uses a bounded release band and leaves it immediately for larger error', () => {
  const filter = createGuidanceStabilizer({ minAlpha: 1, maxAlpha: 1 });
  assert.equal(confirm(filter).guidance.stable, true);
  const near = push(filter, 4, 800, { x: 0.55 });
  assert.equal(near.guidance.stable, true);
  assert.equal(near.guidance.alignmentBand, 'release');
  assert.equal(push(filter, 5, 1050, { x: 0.57 }).guidance.stable, false);

  const size = createGuidanceStabilizer({ minAlpha: 1, maxAlpha: 1 });
  confirm(size);
  assert.equal(push(size, 4, 800, { height: 0.236 }).guidance.stable, true);
  assert.equal(push(size, 5, 1050, { height: 0.25 }).guidance.stable, false);
});

test('manual, example and static-photo matches are immediate and explicitly only references', () => {
  for (const [origin, sourceMode, label] of [
    ['manual', 'camera', '手动参考'], ['example', 'demo', '示例参考'], ['detected', 'photo', '照片参考'],
  ]) {
    const result = createGuidanceStabilizer().update({ ...baseInput, sourceMode, nowMs: 1000,
      observation: { origin, point: target, box: null } });
    assert.equal(result.guidance.score, 100);
    assert.equal(result.guidance.status, 'aligned');
    assert.equal(result.guidance.stable, false);
    assert.equal(result.guidance.referenceOnly, true);
    assert.match(result.guidance.title, new RegExp(label));
    assert.equal(result.tracking.expiresAtMs, null);
  }
});

test('out-of-order events cannot overwrite newer data; malformed clocks and coordinates make no points', () => {
  const filter = createGuidanceStabilizer();
  const accepted = push(filter, 10, 600, { x: 0.57 });
  const old = filter.update({ ...baseInput, nowMs: 800, observation: observation(9, 500, { x: 0.3 }) });
  assert.deepEqual(old.point, accepted.point);
  assert.equal(old.tracking.observationId, 10);
  const future = filter.update({ ...baseInput, nowMs: 900, observation: observation(11, 1000) });
  assert.equal(future.guidance.score, null);
  assert.equal(future.tracking.reason, 'invalid');
  const invalid = push(createGuidanceStabilizer(), 1, 0, { point: { x: NaN, y: 0.75 }, box: null });
  assert.equal(invalid.point, null);
  assert.equal(invalid.guidance.score, null);
  const clock = filter.update({ ...baseInput, nowMs: NaN });
  assert.equal(clock.guidance.score, null);
});

test('input coordinates remain immutable and omitted target uses the shot default', () => {
  const filter = createGuidanceStabilizer();
  const sample = observation(1, 0);
  const copy = structuredClone(sample);
  filter.update({ ...baseInput, nowMs: 0, observation: sample });
  push(filter, 2, 250, { x: 0.52 });
  assert.deepEqual(sample, copy);
  const targetDefault = targetForShot({ shot: 'wide' });
  const automatic = createGuidanceStabilizer();
  let result;
  for (const [index, time] of [0, 250, 550].entries()) {
    result = automatic.update({ shot: 'wide', nowMs: time, sourceKey: 'rear', sourceMode: 'camera',
      observation: observation(index + 1, time, { x: targetDefault.x, y: targetDefault.y }) });
  }
  assert.equal(result.guidance.stable, true);
});
