import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomMotion } from '../dist/zoom-motion.mjs';

test('digital zoom moves monotonically in log space without exceeding its latest target', () => {
  const motion = createZoomMotion(); motion.setTarget(4); motion.step(0);
  let previous = 1;
  for (let time = 16; time <= 1000; time += 16) {
    const state = motion.step(time);
    assert.ok(state.value >= previous && state.value <= 4); previous = state.value;
  }
  assert.deepEqual(motion.getState(), { value: 4, target: 4, active: false, settled: true, min: 1, max: 6 });
});

test('the same elapsed time has the same motion regardless of frame frequency', () => {
  const a = createZoomMotion(), b = createZoomMotion();
  for (const m of [a,b]) { m.setTarget(5); m.step(0); }
  for (let time = 10; time <= 100; time += 10) a.step(time);
  b.step(100);
  assert.ok(Math.abs(a.getState().value - b.getState().value) < 1e-12);
});

test('equal relative zoom changes follow the same proportional curve', () => {
  const a = createZoomMotion({ value: 1 }), b = createZoomMotion({ value: 2, max: 8 });
  a.setTarget(2); b.setTarget(4); a.step(0); b.step(0);
  a.step(45); b.step(45);
  assert.ok(Math.abs(b.getState().value / a.getState().value - 2) < 1e-12);
});

test('a reversed gesture replaces the old target without a queued rebound', () => {
  const motion = createZoomMotion(); motion.setTarget(5); motion.step(0); motion.step(90);
  const peak = motion.getState().value;
  motion.setTarget(1.2); const first = motion.step(106).value;
  assert.ok(first < peak && first > 1.2);
  motion.step(2000); assert.equal(motion.getState().value,1.2);
  motion.step(3000); assert.equal(motion.getState().value,1.2);
});

test('reset cancels old movement and source changes cannot inherit the old target', () => {
  const motion = createZoomMotion(); motion.setTarget(6); motion.step(0); motion.step(32);
  motion.reset(1); motion.step(1000); motion.step(1016);
  assert.equal(motion.getState().value,1); assert.equal(motion.getState().active,false);
});

test('repeated identical pointer targets do not restart smoothing', () => {
  const a = createZoomMotion(), b = createZoomMotion();
  a.setTarget(3); b.setTarget(3); a.step(0); b.step(0);
  a.step(30); b.step(30); a.setTarget(3); a.setTarget(3);
  a.step(60); b.step(60); assert.equal(a.getState().value,b.getState().value);
});

test('bounds clamp targets and invalid values cannot corrupt active state', () => {
  const motion = createZoomMotion({ min: .5, max: 3 });
  motion.setTarget(999); assert.equal(motion.getState().target,3);
  const before = motion.getState(); motion.setTarget(NaN); motion.reset(Infinity); motion.step(NaN);
  assert.deepEqual(motion.getState(),before);
  motion.reset(-20); assert.equal(motion.getState().value,.5);
});

test('reduced-motion mode snaps directly to the requested crop', () => {
  const motion = createZoomMotion({ timeConstantMs: 0 });
  assert.equal(motion.setTarget(2.5).value,2.5); assert.equal(motion.getState().active,false);
});

test('backward or identical clocks do not move the crop or produce invalid values', () => {
  const motion = createZoomMotion(); motion.setTarget(4); motion.step(100); motion.step(120);
  const value = motion.getState().value;
  assert.equal(motion.step(90).value,value); assert.equal(motion.step(90).changed,false);
  assert.ok(motion.step(110).value > value);
});

test('invalid motion bounds are rejected instead of silently inverting the zoom range', () => {
  for (const options of [{min:0},{min:4,max:2},{timeConstantMs:-1},{epsilon:0}]) assert.throws(()=>createZoomMotion(options),RangeError);
});


test('a new gesture after an idle gap starts smoothly instead of consuming idle time', () => {
  const motion = createZoomMotion(); motion.setTarget(2); motion.step(0); motion.step(3000);
  assert.equal(motion.getState().active,false);
  motion.setTarget(4); assert.equal(motion.step(60000).value,2);
  const next = motion.step(60016).value; assert.ok(next > 2 && next < 4);
});
