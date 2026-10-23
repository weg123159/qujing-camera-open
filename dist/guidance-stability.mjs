/**
 * Temporal presentation of measured composition guidance, not a new detector.
 * All coordinates are normalized to the CURRENT visible viewfinder. Only a new
 * observationId is new evidence; repainting an old result never proves stability.
 */
import { SHOTS, targetForShot, assessShotComposition } from './shots.mjs';

export const GUIDANCE_STABILITY_DEFAULTS = Object.freeze({
  smoothingTimeConstantMs: 180,
  minAlpha: 0.2,
  maxAlpha: 0.85,
  minConfidence: Object.freeze({ face: 0.45, person: 0.4 }),
  alignmentHoldMs: 500,
  alignmentSamples: 3,
  directionHoldMs: 180,
  directionSamples: 2,
  axisSwitchMargin: 0.02,
  alignmentExitTolerance: 0.065,
  sizeExitMultiplier: 1.25,
  jumpDistance: 0.22,
  minExpiryMs: 700,
  maxExpiryMs: 4500,
});

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finitePoint = point => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
const visiblePoint = point => finitePoint(point) && point.visible !== false
  && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
const validBox = box => Boolean(box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
  && box.width > 0 && box.height > 0);
const clonePoint = point => finitePoint(point) ? { x: point.x, y: point.y, visible: point.visible !== false } : null;
const cloneBox = box => validBox(box) ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
const blend = (before, after, alpha, keys) => Object.fromEntries(keys.map(key => [key, before[key] + (after[key] - before[key]) * alpha]));
const resolveShot = value => SHOTS.find(shot => shot.id === (typeof value === 'string' ? value : value?.id))
  || SHOTS.find(shot => shot.id === 'wide');

function observedPoint(observation, kind) {
  if (finitePoint(observation?.point)) return clonePoint(observation.point);
  if (observation?.point?.visible === false) return null;
  const box = observation?.box;
  if (!validBox(box)) return null;
  // This is a proxy from a genuine box, exactly as in shots.mjs, not a pose keypoint.
  const x = box.x + box.width / 2;
  const y = box.y + box.height * (kind === 'person' ? 1 : 0.5);
  return { x, y, visible: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

function desiredHeight(shot, target) {
  return shot.kind === 'face' ? shot.faceHeight
    : target?.bodyHeight ?? target?.height ?? shot.recommendedBodyHeight;
}

function withFlags(guidance, flags = {}) {
  return { ...guidance, stable: false, settling: false, referenceOnly: false, ...flags };
}

function emptyGuidance(shot, reason) {
  const labels = {
    cleared: ['等待新的参考位置', '尚无当前观测，不显示匹配度或移动方向。'],
    missing: ['暂未检测到参考主体', '让人物重新进入画面；不会沿用之前的对齐结果。'],
    confidence: ['当前检测还不够可靠', '等待更明确的检测结果；暂不显示匹配度或移动方向。'],
    expired: ['等待更新后的检测', '上一条检测已经过期；请等待新的参考位置。'],
    invalid: ['等待有效的检测信息', '当前观测信息不完整，暂不判断位置或大小。'],
  };
  const [title, detail] = labels[reason] || labels.missing;
  return withFlags({
    status: 'waiting', score: null, distance: null, direction: null, action: null,
    title, detail, positionAligned: false, sizeAligned: null, heightRatio: null,
    shotId: shot.id, kind: shot.kind, anchor: shot.anchor,
  });
}

function settlingGuidance(base, title = '位置和大小接近，等待连续确认') {
  return withFlags({
    ...base, status: 'adjusting', action: 'settling', direction: null,
    title, detail: '还需要连续的新检测来确认。单次对齐或画面重绘不会记作稳定。',
    positionAligned: false,
  }, { settling: true });
}

function directionForAxis(axis, error, { actor, mirrored, sourceMode }) {
  const displayMovement = actor === 'person' || sourceMode !== 'camera';
  if (axis === 'x') return displayMovement ? (error > 0 ? 'left' : 'right')
    : ((error > 0) !== Boolean(mirrored) ? 'right' : 'left');
  return displayMovement ? (error > 0 ? 'up' : 'down') : (error > 0 ? 'down' : 'up');
}

function directedGuidance(base, direction, context, kind) {
  const word = { left: '左', right: '右', up: '上', down: '下' }[direction];
  const title = context.actor === 'person' ? `人物向画面${word}方调整`
    : context.sourceMode !== 'camera' ? `画面向${word}轻移`
      : `${kind === 'person' ? '镜头' : '手机'}向${word}微移`;
  return withFlags({ ...base, status: 'adjusting', action: 'position', direction, title, positionAligned: false });
}

/**
 * createGuidanceStabilizer(options) -> { update(input), reset() }
 *
 * update({
 *   shot, target, actor, mirrored, sourceMode, sourceKey, nowMs,
 *   expectedIntervalMs,
 *   observation: { observationId, capturedAtMs, point, box, confidence,
 *                  subjectKey, origin: 'detected' | 'manual' | 'example',
 *                  expectedIntervalMs }
 * }) -> { point, box, guidance, tracking }
 *
 * observation:null clears immediately. Omit observation to refresh age only.
 * Reuse the same observationId on UI repaint. capturedAtMs and nowMs must share
 * a monotonic clock (performance.now); capture time must not be return time.
 * Change sourceKey on camera session / source / view-crop changes. A changed
 * shot kind, mirroring, or subjectKey also resets automatically. Manual, example
 * and photo references bypass temporal confirmation and remain referenceOnly.
 *
 * Call update periodically without new observations to expire silent streams.
 * tracking.expiresAtMs supplies a deadline if the host prefers a timeout.
 * The defaults are product thresholds, not measured detector accuracy claims.
 */
export function createGuidanceStabilizer(options = {}) {
  const settings = { ...GUIDANCE_STABILITY_DEFAULTS };
  for (const key of Object.keys(settings)) {
    if (key !== 'minConfidence' && Number.isFinite(options[key]) && options[key] >= 0) settings[key] = options[key];
  }
  settings.alignmentSamples = Math.max(2, Math.ceil(settings.alignmentSamples));
  settings.directionSamples = Math.max(2, Math.ceil(settings.directionSamples));
  settings.minAlpha = clamp(settings.minAlpha, 0, 1);
  settings.maxAlpha = clamp(settings.maxAlpha, settings.minAlpha, 1);
  settings.maxExpiryMs = Math.max(settings.minExpiryMs, settings.maxExpiryMs);
  const confidenceLimits = typeof options.minConfidence === 'number'
    ? { face: options.minConfidence, person: options.minConfidence }
    : { ...GUIDANCE_STABILITY_DEFAULTS.minConfidence, ...options.minConfidence };

  let contextKey = null, targetKey = null, latest = null;
  let lastId = null, lastCapturedAt = -Infinity, lastNow = -Infinity;
  let filteredPoint = null, filteredBox = null, previousAcceptedAt = null;
  let selectedSubject = null, lastOrigin = null, reason = 'cleared';
  let alignmentStart = null, alignmentCount = 0, stableForMs = 0, confirmed = false;
  let heldCommand = null, pendingCommand = null;

  function clearDecision() {
    alignmentStart = null; alignmentCount = 0; stableForMs = 0; confirmed = false;
    heldCommand = null; pendingCommand = null;
  }

  function clearEvidence(nextReason, forgetIds = false) {
    latest = null; filteredPoint = null; filteredBox = null; previousAcceptedAt = null;
    selectedSubject = null; lastOrigin = null; reason = nextReason;
    clearDecision();
    if (forgetIds) { lastId = null; lastCapturedAt = -Infinity; }
  }

  function reset() {
    clearEvidence('cleared', true);
    contextKey = null; targetKey = null; lastNow = -Infinity;
  }

  function expiryFor(interval) {
    const actual = Number.isFinite(interval) && interval > 0 ? interval : 250;
    return clamp(actual * 2 + 200, settings.minExpiryMs, settings.maxExpiryMs);
  }

  function supported(direction, point, target, context) {
    if (!visiblePoint(point) || !visiblePoint(target)) return false;
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    const error = point[axis] - target[axis];
    return Math.abs(error) > 0.045 && directionForAxis(axis, error, context) === direction;
  }

  function commandKey(base, shot, target) {
    if (base.action === 'position' && base.direction) return `position:${base.direction}`;
    if (base.action === 'size') return `size:${base.heightRatio > desiredHeight(shot, target) ? 'smaller' : 'larger'}`;
    return null;
  }

  function stabilizeCommand(base, raw, point, target, context, shot, freshSample) {
    let candidate = base;
    if (candidate.action === 'position' && !supported(candidate.direction, point, target, context)) {
      if (raw.action === 'position' && supported(raw.direction, point, target, context)) candidate = raw;
      else return settlingGuidance(candidate, '位置正在变化，等待方向确认');
    }
    const key = commandKey(candidate, shot, target);
    if (!key) return withFlags(candidate);
    if (!heldCommand) { heldCommand = { key, direction: candidate.direction, action: candidate.action }; return withFlags(candidate); }
    if (heldCommand.key === key) { pendingCommand = null; return withFlags(candidate); }

    const oldDirectionUsable = heldCommand.action === 'position'
      && supported(heldCommand.direction, point, target, context);
    if (oldDirectionUsable && candidate.action === 'position') {
      const oldAxis = ['left', 'right'].includes(heldCommand.direction) ? 'x' : 'y';
      const newAxis = ['left', 'right'].includes(candidate.direction) ? 'x' : 'y';
      if (oldAxis !== newAxis && Math.abs(point[newAxis] - target[newAxis])
        < Math.abs(point[oldAxis] - target[oldAxis]) + settings.axisSwitchMargin) {
        pendingCommand = null;
        return directedGuidance(candidate, heldCommand.direction, context, shot.kind);
      }
    }

    if (freshSample) {
      if (pendingCommand?.key === key) pendingCommand.count++;
      else pendingCommand = { key, count: 1, startedAt: latest.capturedAtMs };
      if (pendingCommand.count >= settings.directionSamples
        && latest.capturedAtMs - pendingCommand.startedAt >= settings.directionHoldMs) {
        heldCommand = { key, direction: candidate.direction, action: candidate.action };
        pendingCommand = null;
        return withFlags(candidate);
      }
    }
    if (oldDirectionUsable) return directedGuidance(candidate, heldCommand.direction, context, shot.kind);
    // Never keep a now-wrong direction just to make its arrow look steady.
    return settlingGuidance(candidate, candidate.action === 'size' ? '正在确认大小变化' : '位置正在变化，等待方向确认');
  }

  function withinRelease(raw, smoothed, shot, target, rawPoint) {
    if (!visiblePoint(rawPoint) || !visiblePoint(filteredPoint) || !visiblePoint(target)) return false;
    if (raw.action === 'framing' || raw.status === 'waiting' || smoothed.status === 'waiting') return false;
    if (![raw.heightRatio, smoothed.heightRatio].every(Number.isFinite)) return false;
    const height = desiredHeight(shot, target);
    if (!Number.isFinite(height) || height <= 0) return false;
    const heightTolerance = Math.max(0.025, height * (shot.kind === 'face' ? 0.18 : 0.15)) * settings.sizeExitMultiplier;
    return [rawPoint, filteredPoint].every(point => Math.max(Math.abs(point.x - target.x), Math.abs(point.y - target.y)) <= settings.alignmentExitTolerance)
      && [raw.heightRatio, smoothed.heightRatio].every(value => Math.abs(value - height) <= heightTolerance);
  }

  function update(input = {}) {
    const shot = resolveShot(input.shot);
    const sourceMode = input.sourceMode || 'camera';
    const actor = input.actor === 'person' ? 'person' : 'camera';
    const context = { actor, mirrored: Boolean(input.mirrored), sourceMode };
    const nowMs = input.nowMs;
    const key = JSON.stringify([input.sourceKey ?? sourceMode, sourceMode, shot.kind, context.mirrored]);
    if (key !== contextKey) {
      // A source switch must not make the previous frame ID new again. Camera
      // IDs are session-controller monotonic; reset() explicitly starts a new one.
      clearEvidence('cleared', contextKey === null);
      contextKey = key; targetKey = null; lastNow = -Infinity;
    }
    if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs < lastNow) {
      clearEvidence('invalid');
      return { point: null, box: null, guidance: emptyGuidance(shot, 'invalid'), tracking: { state: 'missing', reason: 'invalid', fresh: false, ageMs: null, confidence: null, stableForMs: 0, sampleCount: 0, expiresAtMs: null } };
    }
    lastNow = nowMs;
    const target = input.target || targetForShot({ shot });
    const nextTargetKey = JSON.stringify([shot.id, target?.x, target?.y, target?.bodyHeight, target?.height, target?.faceHeight, actor]);
    if (nextTargetKey !== targetKey) { clearDecision(); targetKey = nextTargetKey; }

    let freshSample = false;
    const observation = input.observation;
    if (observation === null) clearEvidence('cleared');
    else if (observation !== undefined) {
      const origin = ['manual', 'example'].includes(observation?.origin) ? observation.origin : 'detected';
      const reference = sourceMode !== 'camera' || origin !== 'detected';
      const id = observation?.observationId;
      const capturedAtMs = observation?.capturedAtMs;
      const hasId = typeof id === 'string' || Number.isFinite(id);
      const distinct = reference || (hasId && id !== lastId);
      const outOfOrder = !reference && ((Number.isFinite(capturedAtMs) && capturedAtMs < lastCapturedAt)
        || (typeof id === 'number' && typeof lastId === 'number' && id < lastId));
      if ((!hasId || !Number.isFinite(capturedAtMs) || capturedAtMs < 0 || capturedAtMs > nowMs + 1) && !reference) {
        clearEvidence('invalid');
      } else if (distinct && !outOfOrder) {
        const frameTime = reference ? nowMs : capturedAtMs;
        lastId = id ?? null; lastCapturedAt = frameTime;
        const confidence = observation.confidence == null ? null : observation.confidence;
        const limit = Number.isFinite(confidenceLimits[shot.kind]) ? clamp(confidenceLimits[shot.kind], 0, 1) : 0;
        const unreliable = confidence !== null && (!Number.isFinite(confidence) || confidence < limit || confidence > 1);
        const point = observedPoint(observation, shot.kind), box = cloneBox(observation.box);
        const interval = input.expectedIntervalMs ?? observation.expectedIntervalMs;
        const expiryMs = expiryFor(interval);
        if (unreliable && origin === 'detected') clearEvidence('confidence');
        else if (!point && !box) clearEvidence('missing');
        else if (!reference && nowMs - frameTime > expiryMs) clearEvidence('expired');
        else {
          const subject = observation.subjectKey ?? null;
          const differentSubject = subject !== null && selectedSubject !== null && subject !== selectedSubject;
          const distantJump = visiblePoint(point) && visiblePoint(filteredPoint)
            && Math.hypot(point.x - filteredPoint.x, point.y - filteredPoint.y) > settings.jumpDistance;
          const scaleJump = validBox(box) && validBox(filteredBox)
            && (box.height / filteredBox.height > 1.8 || box.height / filteredBox.height < 1 / 1.8);
          const longGap = previousAcceptedAt !== null && frameTime - previousAcceptedAt > expiryMs;
          if (differentSubject || distantJump || scaleJump || longGap || (lastOrigin !== null && lastOrigin !== origin)) {
            filteredPoint = null; filteredBox = null; previousAcceptedAt = null; clearDecision();
          }
          const raw = assessShotComposition({ shot, point, box, target, ...context });
          const dt = previousAcceptedAt === null ? 0 : Math.max(0, frameTime - previousAcceptedAt);
          const alpha = reference || previousAcceptedAt === null ? 1
            : clamp(1 - Math.exp(-dt / Math.max(1, settings.smoothingTimeConstantMs)), settings.minAlpha, settings.maxAlpha);
          const canSmooth = raw.status !== 'waiting' && raw.action !== 'framing';
          filteredPoint = canSmooth && visiblePoint(point) && visiblePoint(filteredPoint)
            ? { ...blend(filteredPoint, point, alpha, ['x', 'y']), visible: true } : point;
          // An absent or clipped box must not inherit a previous, measurable size.
          filteredBox = canSmooth && raw.sizeAligned !== null && box && filteredBox
            ? blend(filteredBox, box, alpha, ['x', 'y', 'width', 'height']) : box;
          selectedSubject = subject;
          previousAcceptedAt = frameTime; lastOrigin = origin; reason = null;
          latest = { point, box, confidence, subjectKey: subject, capturedAtMs: frameTime,
            observationId: id ?? null, expiryMs, origin, reference };
          freshSample = true;
        }
      }
    }

    if (latest && !latest.reference && nowMs - latest.capturedAtMs > latest.expiryMs) clearEvidence('expired');
    if (!latest) return {
      point: null, box: null, guidance: emptyGuidance(shot, reason),
      tracking: { state: 'missing', reason, fresh: false, ageMs: null, confidence: null, stableForMs: 0, sampleCount: 0, expiresAtMs: null },
    };

    const raw = assessShotComposition({ shot, point: latest.point, box: latest.box, target, ...context });
    const smoothed = assessShotComposition({ shot, point: filteredPoint, box: filteredBox, target, ...context });
    let base = smoothed;
    const ageMs = Math.max(0, nowMs - latest.capturedAtMs);
    const tracking = { state: 'tracking', reason: null, fresh: true, ageMs,
      confidence: latest.confidence, observationId: latest.observationId, subjectKey: latest.subjectKey,
      stableForMs, sampleCount: alignmentCount, expiresAtMs: latest.reference ? null : latest.capturedAtMs + latest.expiryMs };
    const output = guidance => ({ point: clonePoint(filteredPoint), box: cloneBox(filteredBox), guidance,
      tracking: { ...tracking, state: latest.reference ? 'reference' : guidance.stable ? 'stable' : guidance.settling ? 'settling' : guidance.status === 'waiting' ? 'missing' : 'tracking',
        stableForMs, sampleCount: alignmentCount } });

    if (latest.reference) {
      const label = latest.origin === 'example' ? '示例参考' : latest.origin === 'manual' ? '手动参考' : '照片参考';
      const guidance = withFlags({ ...raw,
        title: raw.status === 'aligned' ? `${label}已接近目标` : raw.title,
        detail: `${label}只比较当前画面的位置${raw.sizeAligned !== null ? '和参考大小' : ''}，不代表实时检测稳定。${raw.detail || ''}`,
      }, { referenceOnly: true });
      return output(guidance);
    }
    if (raw.action === 'framing' || raw.status === 'waiting') {
      clearDecision(); filteredPoint = latest.point; filteredBox = latest.box;
      return output(withFlags(raw));
    }

    // A mean of two off-target observations is not observed alignment.
    if ((base.status === 'aligned' && raw.status !== 'aligned')
      || (raw.action === 'position' && base.action !== 'position')) base = raw;
    if (confirmed && withinRelease(raw, smoothed, shot, target, latest.point)) {
      if (freshSample) stableForMs = latest.capturedAtMs - alignmentStart;
      return output(withFlags({ ...base, status: 'aligned', action: null, direction: null,
        title: '位置和大小持续接近参考',
        detail: '最近多次有效检测接近参考。匹配度只衡量位置；仍需自行确认表情、姿态和背景。',
        positionAligned: true, sizeAligned: true, alignmentBand: 'release',
      }, { stable: true }));
    }
    if (confirmed) { confirmed = false; alignmentStart = null; alignmentCount = 0; stableForMs = 0; }
    const eligible = raw.status === 'aligned' && base.status === 'aligned'
      && raw.sizeAligned === true && base.sizeAligned === true;
    if (eligible) {
      heldCommand = null; pendingCommand = null;
      if (freshSample) {
        if (alignmentStart === null) alignmentStart = latest.capturedAtMs;
        alignmentCount++;
        stableForMs = latest.capturedAtMs - alignmentStart;
      }
      if (alignmentCount >= settings.alignmentSamples && stableForMs >= settings.alignmentHoldMs) {
        confirmed = true;
        return output(withFlags({ ...base, status: 'aligned', action: null, direction: null,
          title: '位置和大小持续接近参考',
          detail: '最近多次有效检测接近参考。匹配度只衡量位置；仍需自行确认表情、姿态和背景。',
          alignmentBand: 'entry',
        }, { stable: true }));
      }
      return output(settlingGuidance(base));
    }
    alignmentStart = null; alignmentCount = 0; stableForMs = 0;
    if (base.status === 'aligned' && base.sizeAligned === null) {
      return output(withFlags({ ...base, status: 'adjusting', action: 'reference', direction: null,
        title: '参考点接近，大小尚未确认',
        detail: '目前只能比较参考位置；缺少可测的完整参考框，不判断整体对齐。',
      }, { referenceOnly: true }));
    }
    return output(stabilizeCommand(base, raw, latest.point, target, context, shot, freshSample));
  }

  return { update, reset };
}
