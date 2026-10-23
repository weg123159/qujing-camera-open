/**
 * Geometry and positional composition guidance. No image recognition is performed
 * here. All public points are normalized (0..1); only crop rectangles use pixels.
 */

const ALIGNMENT_TOLERANCE = 0.045;
// Product caution threshold: a detection within 1.5% of any image edge may
// already have been clipped by the detector. This is not a pose/visibility test.
const BODY_EDGE_MARGIN = 0.015;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isPositive = (value) => Number.isFinite(value) && value > 0;
const isUnitPoint = (point) => Boolean(
  point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
);

/** Source pixel rectangle for a centered object-fit: cover presentation. */
export function getCoverCrop(sourceWidth, sourceHeight, viewWidth, viewHeight) {
  if (![sourceWidth, sourceHeight, viewWidth, viewHeight].every(isPositive)) {
    throw new RangeError('Source and view dimensions must be finite positive numbers.');
  }
  const targetRatio = viewWidth / viewHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  const cropWidth = sourceRatio > targetRatio ? sourceHeight * targetRatio : sourceWidth;
  const cropHeight = sourceRatio > targetRatio ? sourceHeight : sourceWidth / targetRatio;
  return {
    sx: (sourceWidth - cropWidth) / 2,
    sy: (sourceHeight - cropHeight) / 2,
    sw: cropWidth,
    sh: cropHeight,
  };
}

/**
 * Map a normalized source point through the same crop as the visible image.
 * Mirror AFTER cropping, as for CSS transform: scaleX(-1) on the video element.
 * An unavailable frame / invalid point is explicitly invisible.
 */
export function sourcePointToView(
  point, sourceWidth, sourceHeight, viewWidth, viewHeight, mirrored = false,
) {
  if (!isUnitPoint(point) || ![sourceWidth, sourceHeight, viewWidth, viewHeight].every(isPositive)) {
    return { x: NaN, y: NaN, visible: false };
  }
  const crop = getCoverCrop(sourceWidth, sourceHeight, viewWidth, viewHeight);
  const rawX = (point.x * sourceWidth - crop.sx) / crop.sw;
  const y = (point.y * sourceHeight - crop.sy) / crop.sh;
  const x = mirrored ? 1 - rawX : rawX;
  return { x, y, visible: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

/**
 * Transform a normalized SOURCE box without discarding off-frame evidence.
 * Unlike a subject point, box corners may legitimately be outside [0,1].
 * sourceCrop optionally supplies the exact source-pixel crop used for static
 * pan/zoom; otherwise the same centered cover crop as the video is used.
 * The returned view box is intentionally NOT clamped to [0,1].
 */
export function sourceBoxToView(
  box, sourceWidth, sourceHeight, viewWidth, viewHeight, mirrored = false, sourceCrop = null,
) {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
    || box.width <= 0 || box.height <= 0
    || ![sourceWidth, sourceHeight, viewWidth, viewHeight].every(isPositive)) return null;
  const crop = sourceCrop === null ? getCoverCrop(sourceWidth, sourceHeight, viewWidth, viewHeight) : sourceCrop;
  if (!crop || ![crop.sx, crop.sy, crop.sw, crop.sh].every(Number.isFinite) || crop.sw <= 0 || crop.sh <= 0) return null;
  const left = (box.x * sourceWidth - crop.sx) / crop.sw;
  const y = (box.y * sourceHeight - crop.sy) / crop.sh;
  const width = box.width * sourceWidth / crop.sw;
  const height = box.height * sourceHeight / crop.sh;
  const x = mirrored ? 1 - left - width : left;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

/** Preset positions are adjustable composition references, not aesthetic rules. */
export const PRESETS = Object.freeze([
  { id: 'thirds', name: '三分法', subtitle: '人物与环境相互呼应', description: '让人物靠近三分线，为周围的环境留出空间。', defaultHeight: 0.3 },
  { id: 'center', name: '居中构图', subtitle: '让人物成为画面中心', description: '将人物放在中轴附近，适合明确、安定的画面。', defaultHeight: 0.4 },
  { id: 'negative', name: '留白构图', subtitle: '给视线和风景留空间', description: '把人物放向一侧，让空出来的环境参与表达。', defaultHeight: 0.26 },
  { id: 'golden', name: '黄金分割', subtitle: '比三分法更靠近中心', description: '把人物放在约六成的位置，观察人与环境的比例。', defaultHeight: 0.32 },
  { id: 'symmetry', name: '对称构图', subtitle: '呼应两侧的建筑与环境', description: '先找背景的对称轴，再把人物放在轴线上。', defaultHeight: 0.4 },
  { id: 'diagonal', name: '对角线构图', subtitle: '让斜线带出画面动势', description: '让人物与斜坡、栏杆或道路的斜向走势呼应。', defaultHeight: 0.3 },
  { id: 'leading', name: '引导线构图', subtitle: '让道路和栏杆引向人物', description: '观察背景线条的延伸方向，把人物安排在视觉落点。', defaultHeight: 0.28 },
  { id: 'frame', name: '框架构图', subtitle: '借门窗与树枝围住人物', description: '先找到环境中的框，再把人物放进留出的空间。', defaultHeight: 0.34 },
  { id: 'wide', name: '远景构图', subtitle: '人小一点，风景多一点', description: '让人物约占画面高度的两成，保留完整的人和更多环境。', defaultHeight: 0.2 },
].map(Object.freeze));

/**
 * Face mode preserves the original three presets' return shapes and positions.
 * Person mode returns a foot target plus the normalized outline height. Callers
 * may override bodyHeight; an omitted wide-mode height defaults to 20%.
 * Background lines / symmetry / frames are NOT automatically detected here.
 */
export function targetFor(preset = 'thirds', side = 'right', kind = 'face', bodyHeight = 0.3) {
  const config = PRESETS.find((entry) => entry.id === preset) || PRESETS[0];
  const isLeft = side === 'left';
  const facePoints = {
    thirds: { x: isLeft ? 1 / 3 : 2 / 3, y: 1 / 3 },
    center: { x: 0.5, y: 0.4 },
    negative: { x: isLeft ? 0.27 : 0.73, y: 0.4 },
    golden: { x: isLeft ? 0.382 : 0.618, y: 0.382 },
    symmetry: { x: 0.5, y: 0.4 },
    diagonal: { x: isLeft ? 0.3 : 0.7, y: isLeft ? 0.48 : 0.36 },
    leading: { x: isLeft ? 0.38 : 0.62, y: 0.4 },
    frame: { x: isLeft ? 0.4 : 0.6, y: 0.4 },
    wide: { x: isLeft ? 1 / 3 : 2 / 3, y: 0.56 },
  };
  const point = facePoints[config.id];
  if (kind !== 'person') return { ...point, label: config.name };
  const requestedHeight = config.id === 'wide' && arguments.length < 4 ? config.defaultHeight : bodyHeight;
  const height = clamp(Number.isFinite(requestedHeight) ? requestedHeight : config.defaultHeight, 0.08, 0.85);
  const footY = { thirds: 0.78, center: 0.8, negative: 0.78, golden: 0.78, symmetry: 0.81, diagonal: isLeft ? 0.82 : 0.72, leading: 0.74, frame: 0.8, wide: 0.76 }[config.id];
  return { x: point.x, y: clamp(footY, height + 0.055, 0.95), label: config.name, height };
}

const waiting = (title, detail) => ({
  status: 'waiting', score: null, title, detail, direction: null, distance: null,
});

/**
 * Return ONE camera movement, selecting the axis with the largest discrepancy.
 * `point` and `target` are in the visible viewfinder's normalized coordinates.
 * For a rear camera, moving right shifts the scene left. Selfie mirroring flips
 * that horizontal relationship. The vertical relationship remains unchanged.
 * `steadyMs` is accepted for caller compatibility but does not invent motion data.
 * Score measures reference-point proximity only; it is not an aesthetic score.
 */
export function assessComposition({ point, target, mirrored = false, steadyMs = 0 } = {}) {
  void steadyMs;
  if (!isUnitPoint(target)) {
    return waiting('请选择构图方式', '选择一个构图参考位置后，即可获得移动建议。');
  }
  if (!isUnitPoint(point) || point.visible === false) {
    return waiting('让主体进入画面', '识别人脸，或点选一个参考位置后再获取建议。');
  }
  const dx = point.x - target.x;
  const dy = point.y - target.y;
  const distance = Math.hypot(dx, dy);
  const score = Math.min(100, Math.max(0, Math.round(100 * (1 - distance / 0.65))));
  if (Math.max(Math.abs(dx), Math.abs(dy)) <= ALIGNMENT_TOLERANCE + Number.EPSILON) {
    return {
      status: 'aligned', score,
      title: '位置合适，可以拍了',
      detail: '主体参考点已靠近目标。留意表情和背景，再按快门。',
      direction: null, distance,
    };
  }
  let direction;
  if (Math.abs(dx) >= Math.abs(dy)) {
    direction = (dx > 0) !== Boolean(mirrored) ? 'right' : 'left';
  } else {
    direction = dy > 0 ? 'down' : 'up';
  }
  const directionText = { left: '左', right: '右', up: '上', down: '下' };
  return {
    status: 'adjusting', score,
    title: `手机向${directionText[direction]}微移`,
    detail: '让主体参考点靠近亮色目标，每次只调整一个方向。',
    direction, distance,
  };
}

const isBodyBox = (box) => Boolean(box
  && [box.x, box.y, box.width, box.height].every(Number.isFinite)
  && box.width > 0 && box.height > 0);

/**
 * Full-person guidance in VISIBLE normalized view coordinates. The detected
 * box's bottom center is only an approximation of the feet, not a pose keypoint.
 * A valid manual foot point can produce positional guidance without a box, but
 * then no height fit is claimed. The score ALWAYS measures foot-point alignment;
 * size fit is separate. No pixel displacement is converted to ground distance.
 */
export function assessBodyComposition({ point, box, target, desiredHeight, actor = 'camera', mirrored = false } = {}) {
  actor = actor === 'person' ? 'person' : 'camera';
  const boxValid = isBodyBox(box);
  const approximate = true;
  const noSubject = (title, detail) => ({
    ...waiting(title, detail), actor, approximate, action: null,
    heightRatio: null, sizeAligned: null, positionAligned: false,
  });
  // A box outside the frame is not evidence of an intact person. Do not score
  // an inferred foot location or treat that partial box as full body height.
  // Check this BEFORE foot validity: an off-frame bottom center is itself a
  // framing problem, not simply an absent subject.
  if (boxValid && (box.x < 0 || box.y < 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001)) {
    return {
      ...noSubject('先让人物完整入镜', '人物框超出了画面。先调整取景，再确认头部和脚部都能看见。'),
      status: 'adjusting', action: 'framing',
    };
  }
  if (boxValid && (box.x <= BODY_EDGE_MARGIN || box.y <= BODY_EDGE_MARGIN
    || box.x + box.width >= 1 - BODY_EDGE_MARGIN || box.y + box.height >= 1 - BODY_EDGE_MARGIN)) {
    return {
      ...noSubject('请确认头脚完整，并留出边缘', '人物框靠近画面边缘，无法仅凭检测框确认头脚完整。先微调取景，留出一点空间。'),
      status: 'adjusting', action: 'framing',
    };
  }
  if (!isUnitPoint(target)) return noSubject('先选择人物目标位置', '选择构图方式，或在背景中确定一个脚点。');
  if (point?.visible === false) return noSubject('让人物进入取景框', '当前参考点不在画面内，暂时无法比较人物位置。');
  const foot = isUnitPoint(point) ? point : boxValid ? { x: box.x + box.width / 2, y: box.y + box.height } : null;
  if (!isUnitPoint(foot)) return noSubject('等待人物参考位置', '识别完整人物，或手动标记脚点；没有参考位置时不显示匹配度。');

  const wanted = Number.isFinite(desiredHeight) && desiredHeight > 0 && desiredHeight <= 1
    ? desiredHeight : Number.isFinite(target.height) && target.height > 0 && target.height <= 1 ? target.height : null;
  const heightRatio = boxValid ? box.height : null;
  const sizeAligned = heightRatio !== null && wanted !== null
    ? Math.abs(heightRatio - wanted) <= Math.max(0.025, wanted * 0.15) : null;
  const dx = foot.x - target.x;
  const dy = foot.y - target.y;
  const distance = Math.hypot(dx, dy);
  const score = clamp(Math.round(100 * (1 - distance / 0.65)), 0, 100);
  const positionAligned = Math.max(Math.abs(dx), Math.abs(dy)) <= ALIGNMENT_TOLERANCE + Number.EPSILON;
  const common = { score, distance, actor, approximate, heightRatio, sizeAligned, positionAligned };

  if (!positionAligned) {
    let direction;
    if (actor === 'person') {
      direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'up' : 'down');
    } else {
      direction = Math.abs(dx) >= Math.abs(dy)
        ? ((dx > 0) !== Boolean(mirrored) ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    const text = { left: '左', right: '右', up: '上', down: '下' }[direction];
    return {
      ...common, status: 'adjusting', action: 'position', direction,
      title: actor === 'person' ? `人物向画面${text}方调整` : `镜头向${text}微移`,
      detail: actor === 'person'
        ? '按取景画面中的目标点调整站位；上下指画面方向，不代表实际地面路线。'
        : '让人物框底边的参考点靠近目标；这个点只是脚部位置的近似。',
    };
  }
  if (sizeAligned === false) {
    const tooLarge = heightRatio > wanted;
    return {
      ...common, status: 'adjusting', action: 'size', direction: null,
      title: actor === 'person'
        ? (tooLarge ? '人物离镜头远一点' : '人物靠近镜头一点')
        : (tooLarge ? '拉远镜头，让人物小一些' : '拉近镜头，让人物大一些'),
      detail: `人物约占画面高度 ${Math.round(heightRatio * 100)}%，目标为 ${Math.round(wanted * 100)}%。位置匹配度不包含大小判断。`,
    };
  }
  return {
    ...common, status: 'aligned', action: null, direction: null,
    title: sizeAligned === true ? '人物位置与大小都合适' : '脚点位置已对齐',
    detail: sizeAligned === true
      ? '再确认头脚完整、姿态自然。人物框底边只是脚点近似。'
      : '当前只比较脚点位置；缺少完整人物框，尚未评估人物大小。',
  };
}
