/**
 * Frame-rate independent motion for digital crops and requested-value feedback.
 * This never represents a hardware setting: CameraController readback is the
 * only source of applied track zoom. Keep one controller per visible crop.
 */
export function createZoomMotion({ value = 1, min = 1, max = 6, timeConstantMs = 60, epsilon = .001 } = {}) {
  if (![min, max].every(Number.isFinite) || min <= 0 || max < min) throw new RangeError('Zoom bounds must be positive and ordered.');
  if (!Number.isFinite(timeConstantMs) || timeConstantMs < 0) throw new RangeError('Motion time constant must be non-negative.');
  if (!Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) throw new RangeError('Motion tolerance must be between zero and one.');
  const constrain = candidate => Number.isFinite(candidate) ? Math.max(min, Math.min(max, candidate)) : null;
  let actual = constrain(value) ?? min;
  let target = actual;
  let lastTime = null;
  let active = false;
  const getState = () => ({ value: actual, target, active, settled: !active, min, max });
  const reset = candidate => {
    const next = constrain(candidate);
    if (next === null) return getState();
    actual = target = next; active = false; lastTime = null;
    return getState();
  };
  const setTarget = candidate => {
    const next = constrain(candidate);
    if (next === null) return getState();
    const wasActive = active;
    target = next;
    active = Math.abs(Math.log(target / actual)) > epsilon;
    if (active && !wasActive) lastTime = null;
    if (!active || timeConstantMs === 0) { actual = target; active = false; }
    return getState();
  };
  const step = timestampMs => {
    const previous = actual;
    if (!Number.isFinite(timestampMs)) return { ...getState(), changed: false };
    if (lastTime === null || timestampMs < lastTime) { lastTime = timestampMs; return { ...getState(), changed: false }; }
    const elapsed = timestampMs - lastTime;
    lastTime = timestampMs;
    if (active && elapsed > 0) {
      // Equal proportional changes (1→2, 2→4) feel alike. Exponential decay
      // depends on elapsed time, not the number of pointer or animation events.
      const remaining = Math.log(target / actual);
      actual *= Math.exp(remaining * -Math.expm1(-elapsed / timeConstantMs));
      if (Math.abs(Math.log(target / actual)) <= epsilon) { actual = target; active = false; }
    }
    return { ...getState(), changed: actual !== previous };
  };
  return Object.freeze({ getState, setTarget, step, reset });
}
