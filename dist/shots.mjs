/**
 * Shot size is independent of composition layout.
 * The named crops below are practical product conventions; the illustration
 * ratios are not universal photography rules, lens settings, or ground distances.
 */
import { targetFor, assessComposition, assessBodyComposition } from './guide.mjs';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const validPoint = (point) => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
const validBox = (box) => Boolean(box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
  && box.width > 0 && box.height > 0);

// These values describe the shared SVG illustration, never measured anatomy.
export const SHOT_TEMPLATE_COORDINATES = Object.freeze({
  width: 200, height: 500, centerX: 100, headTop: 10, feetY: 480,
  faceX: 100, faceY: 45, bodySpan: 470, referenceFaceHeight: 0.12,
});
const FACE_Y_IN_BODY = (45 - 10) / 470;
const REFERENCE_FRAME_TOP = 0.07;
const REFERENCE_FRAME_BOTTOM = 0.99;
const VISIBLE_REFERENCE_HEIGHT = REFERENCE_FRAME_BOTTOM - REFERENCE_FRAME_TOP;

const definitions = [
  {
    id: 'extreme_wide', name: '大远景', description: '环境占主导，人物只作空间与尺度的参照。',
    kind: 'person', anchor: 'feet', referenceVisibleBody: { top: 0, bottom: 1 },
    recommendedBodyHeight: 0.1, cutAt: 'feet', cropHint: '保留完整人物，让更多山川、街道或建筑进入画面。',
  },
  {
    id: 'wide', name: '远景', description: '看清人物所在的环境，人物仍完整地留在画面中。',
    kind: 'person', anchor: 'feet', referenceVisibleBody: { top: 0, bottom: 1 },
    recommendedBodyHeight: 0.2, cutAt: 'feet', cropHint: '保留头脚和周围环境，先安排人物与背景的位置关系。',
  },
  {
    id: 'full', name: '全景', description: '完整呈现从头到脚的动作与姿态。',
    kind: 'person', anchor: 'feet', referenceVisibleBody: { top: 0, bottom: 1 },
    recommendedBodyHeight: 0.78, cutAt: 'feet', cropHint: '头顶和脚底都留一点空间，再确认手部没有被意外裁切。',
  },
  {
    id: 'medium_full', name: '中全景', description: '膝部以上入画，兼顾上半身动作和部分环境。',
    kind: 'face', anchor: 'face', referenceVisibleBody: { top: 0, bottom: 0.74 },
    recommendedBodyHeight: null, cutAt: 'knees', cropHint: '参考膝部上方的裁切，别让画面边缘正好切在膝关节上。',
  },
  {
    id: 'medium', name: '中景', description: '腰部以上入画，兼顾表情、手势和人物关系。',
    kind: 'face', anchor: 'face', referenceVisibleBody: { top: 0, bottom: 0.53 },
    recommendedBodyHeight: null, cutAt: 'waist', cropHint: '以腰部附近为裁切参考，抬起的手或重要动作应完整保留。',
  },
  {
    id: 'close', name: '近景', description: '胸部或肩部以上入画，突出表情与视线。',
    kind: 'face', anchor: 'face', referenceVisibleBody: { top: 0, bottom: 0.29 },
    recommendedBodyHeight: null, cutAt: 'chest', cropHint: '参考胸部以上取景，留意头顶空间和视线朝向。',
  },
  {
    id: 'detail', name: '特写', description: '画面以面部为主，让表情细节成为重点。',
    kind: 'face', anchor: 'face', referenceVisibleBody: { top: 0, bottom: 0.15 },
    recommendedBodyHeight: null, cutAt: 'face', cropHint: '以面部为取景参考，额头和下巴的取舍由你确认；眼睛等局部特写可用手动参考。',
  },
];

export const SHOTS = Object.freeze(definitions.map((entry) => {
  const span = entry.referenceVisibleBody.bottom - entry.referenceVisibleBody.top;
  return Object.freeze({
    ...entry,
    referenceVisibleBody: Object.freeze(entry.referenceVisibleBody),
    faceHeight: entry.kind === 'face'
      ? SHOT_TEMPLATE_COORDINATES.referenceFaceHeight * VISIBLE_REFERENCE_HEIGHT / span : null,
  });
}));

function resolveShot(shot) {
  const id = typeof shot === 'string' ? shot : shot?.id;
  return SHOTS.find((entry) => entry.id === id) || SHOTS.find((entry) => entry.id === 'wide');
}

function matchingManualTarget(manual, shot) {
  return validPoint(manual)
    && (!manual.kind || manual.kind === shot.kind)
    && (!manual.anchor || manual.anchor === shot.anchor);
}

/**
 * Returns a foot target for complete-body shots and a FACE CENTER target for
 * the four tighter shots. Height refers to the measured kind, never an inferred
 * whole-body height in face mode. Manual targets cannot switch anchor semantics.
 */
export function targetForShot({ shot = 'wide', preset = 'thirds', side = 'right', manualTarget = null } = {}) {
  const config = resolveShot(shot);
  const manual = matchingManualTarget(manualTarget, config) ? manualTarget : null;
  const common = {
    label: config.name, shotId: config.id, kind: config.kind, anchor: config.anchor,
    cropHint: config.cropHint,
  };
  if (config.kind === 'person') {
    const requestedHeight = manual?.bodyHeight ?? manual?.height ?? config.recommendedBodyHeight;
    const bodyHeight = Number.isFinite(requestedHeight) && requestedHeight > 0
      ? clamp(requestedHeight, 0.04, 0.9) : config.recommendedBodyHeight;
    const base = targetFor(preset, side, 'person', bodyHeight);
    return { ...common, x: manual?.x ?? base.x, y: manual?.y ?? Math.max(base.y, bodyHeight + 0.055), height: bodyHeight, bodyHeight };
  }
  const base = targetFor(preset, side, 'face');
  const fullBodyScale = config.faceHeight / SHOT_TEMPLATE_COORDINATES.referenceFaceHeight;
  const y = REFERENCE_FRAME_TOP + (FACE_Y_IN_BODY - config.referenceVisibleBody.top) * fullBodyScale;
  return { ...common, x: manual?.x ?? base.x, y: manual?.y ?? y, height: config.faceHeight, faceHeight: config.faceHeight };
}

/**
 * The SVG's viewBox is 0 0 200 500; actual head/feet references are y=10/480.
 * DOM usage: place that entire SVG at {left,top,width,height} * 100 percent,
 * with overflow clipped by the viewfinder. No separate crop of the SVG is needed.
 * For canonical points centered at x=0 and y=0 at the head, y=1 at the feet:
 *   viewX = translateX + canonicalX * scaleX
 *   viewY = translateY + canonicalY * scaleY
 */
export function getShotTemplateTransform({ shot = 'wide', target, aspect = 0.75 } = {}) {
  const config = resolveShot(shot);
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const anchor = validPoint(target) ? target : targetForShot({ shot: config });
  let fullBodyHeight;
  if (config.kind === 'person') {
    const requested = anchor.bodyHeight ?? anchor.height ?? config.recommendedBodyHeight;
    fullBodyHeight = Number.isFinite(requested) && requested > 0 ? requested : config.recommendedBodyHeight;
  } else {
    // Face templates are illustration crops, not reconstructed human anatomy.
    fullBodyHeight = config.faceHeight / SHOT_TEMPLATE_COORDINATES.referenceFaceHeight;
  }
  const width = SHOT_TEMPLATE_COORDINATES.width / SHOT_TEMPLATE_COORDINATES.bodySpan * fullBodyHeight / aspect;
  const height = SHOT_TEMPLATE_COORDINATES.height / SHOT_TEMPLATE_COORDINATES.bodySpan * fullBodyHeight;
  const left = anchor.x - SHOT_TEMPLATE_COORDINATES.centerX / SHOT_TEMPLATE_COORDINATES.width * width;
  const anchorY = config.anchor === 'feet' ? SHOT_TEMPLATE_COORDINATES.feetY : SHOT_TEMPLATE_COORDINATES.faceY;
  const top = anchor.y - anchorY / SHOT_TEMPLATE_COORDINATES.height * height;
  return {
    left, top, width, height,
    translateX: anchor.x,
    translateY: top + SHOT_TEMPLATE_COORDINATES.headTop / SHOT_TEMPLATE_COORDINATES.height * height,
    scaleX: fullBodyHeight / aspect, scaleY: fullBodyHeight,
    fullBodyHeight, anchor: config.anchor, shotId: config.id,
    referenceVisibleBody: config.referenceVisibleBody,
    clip: { x: 0, y: 0, width: 1, height: 1 },
  };
}

function observationPoint(point, box, kind) {
  if (point?.visible === false) return point;
  if (validPoint(point)) return point;
  if (!validBox(box)) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height * (kind === 'person' ? 1 : 0.5) };
}

function displayDirection(point, target) {
  if (!validPoint(point) || !validPoint(target)) return null;
  const dx = point.x - target.x, dy = point.y - target.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'up' : 'down');
}

function adaptPosition(result, { actor, sourceMode, point, target }) {
  if (!result.direction || result.status !== 'adjusting') return result;
  if (actor === 'person' || sourceMode !== 'camera') {
    const direction = displayDirection(point, target);
    if (!direction) return result;
    const word = { left: '左', right: '右', up: '上', down: '下' }[direction];
    return {
      ...result, direction,
      title: actor === 'person' ? `人物向画面${word}方调整` : `画面向${word}轻移`,
      detail: actor === 'person'
        ? '按取景画面的目标位置调整；画面上下不代表实际地面路线。'
        : '拖动画面，让参考点靠近目标；这里调整的是照片取景。',
    };
  }
  return result;
}

/**
 * Whole-body validation applies only to the three complete-body shot sizes.
 * Tighter shots use detected FACE bounds; an absent waist/knee is intentional.
 * A face bounding box does not prove a waist/knee crop or identify a pose.
 * score remains positional alignment only; sizeAligned is a separate estimate.
 */
export function assessShotComposition({ shot = 'wide', point, box, target, actor = 'camera', mirrored = false, sourceMode = 'camera' } = {}) {
  const config = resolveShot(shot);
  actor = actor === 'person' ? 'person' : 'camera';
  const observed = observationPoint(point, box, config.kind);
  const chosenTarget = target || targetForShot({ shot: config });
  const common = { shotId: config.id, kind: config.kind, anchor: config.anchor, cropHint: config.cropHint, actor };
  if (config.kind === 'person') {
    const desiredHeight = chosenTarget.bodyHeight ?? chosenTarget.height ?? config.recommendedBodyHeight;
    let result = assessBodyComposition({ point: observed, box, target: chosenTarget, desiredHeight, actor, mirrored });
    result = adaptPosition(result, { actor, sourceMode, point: observed, target: chosenTarget });
    if (result.action === 'size' && actor === 'camera' && sourceMode !== 'camera') {
      result = { ...result, title: result.heightRatio > desiredHeight ? '缩小画面，保留完整人物' : '放大画面，让人物更突出' };
    }
    return { ...result, ...common, measurementNote: '人体框底边是脚点近似；匹配度只衡量位置。' };
  }

  const base = assessComposition({ point: observed, target: chosenTarget, mirrored });
  const faceHeight = config.faceHeight;
  // Edge-clipped detections are not reliable size measurements. Positional
  // references can still be useful for a deliberate close-up.
  const measurable = validBox(box) && box.x > 0 && box.y > 0 && box.x + box.width < 1 && box.y + box.height < 1;
  const heightRatio = measurable ? box.height : null;
  const sizeAligned = heightRatio === null ? null : Math.abs(heightRatio - faceHeight) <= Math.max(0.025, faceHeight * 0.18);
  const cropPart = { knees: '膝部', waist: '腰部', chest: '胸部', face: '面部边缘' }[config.cutAt];
  const measurementNote = `只比较脸部参考框，不能由脸框确认${cropPart}裁切或人物姿态。`;
  const shared = { ...common, heightRatio, sizeAligned, approximate: true, measurementNote };
  if (base.status === 'waiting') {
    return { ...base, ...shared, action: null, heightRatio: null, sizeAligned: null, positionAligned: false,
      title: '等待脸部参考位置', detail: '让脸部进入画面，或手动标记脸部中心；暂无参考点时不显示匹配度。' };
  }
  if (base.status === 'adjusting') {
    const positioned = adaptPosition({ ...base, ...shared, action: 'position', positionAligned: false }, { actor, sourceMode, point: observed, target: chosenTarget });
    return positioned;
  }
  if (sizeAligned === false) {
    const tooLarge = heightRatio > faceHeight;
    const title = actor === 'person' ? (tooLarge ? '人物离镜头远一点' : '人物靠近镜头一点')
      : sourceMode === 'camera' ? (tooLarge ? '稍拉远镜头，给脸部多一点空间' : '稍拉近镜头，让脸部更突出')
      : tooLarge ? '缩小画面，给脸部多一点空间' : '放大画面，让脸部更突出';
    return {
      ...base, ...shared, status: 'adjusting', action: 'size', direction: null, positionAligned: true, title,
      detail: `脸部约占画面高度 ${Math.round(heightRatio * 100)}%，参考为 ${Math.round(faceHeight * 100)}%；${cropPart}裁切仍需对照示意确认。`,
    };
  }
  return {
    ...base, ...shared, action: null, positionAligned: true,
    title: sizeAligned === true ? '脸部位置与比例接近参考' : '脸部参考点已对齐',
    detail: sizeAligned === true ? `${config.cropHint} 脸框不能确认${cropPart}裁切。`
      : validBox(box) ? `脸框靠近画面边缘，暂不判断大小；请按示意确认${cropPart}取舍。`
      : '当前只比较脸部中心的位置；没有脸框时不判断大小或身体裁切。',
  };
}
