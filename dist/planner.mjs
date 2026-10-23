/**
 * Background-only standing-position planner. Input region is a USER-SELECTED
 * foot-point region, never a region inferred to be safe or walkable.
 * Ranking compares sampled grayscale variation and local contrast in currently
 * visible prospective head/shoulder regions, plus composition-target distance.
 * Authored pose geometry constrains the footprint when a pose is supplied.
 * It does not understand terrain, depth, line semantics, or the real person's pose.
 */

import { getPoseGeometry, computePoseFootprint, analyzeTargetBackground,
  assessTargetBackgroundOcclusion, BACKGROUND_OCCLUSION_THRESHOLD } from './composition-engine.mjs';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const FRAME_MARGIN = 0.02;
const BODY_WIDTH_TO_HEIGHT = 0.42;
const SCORE_WEIGHTS = Object.freeze({ background: 0.68, composition: 0.32 });

/** A conservative standing outline rectangle, using actual image aspect. */
export function personFootprint({ x, y, height, aspect = 1, poseId, poseMirrored = false } = {}) {
  if (![x, y, height, aspect].every(Number.isFinite) || height <= 0 || aspect <= 0) return null;
  if (poseId) return computePoseFootprint({poseId,x,y,height,aspect,mirrored:poseMirrored});
  const width = height * BODY_WIDTH_TO_HEIGHT / aspect;
  return { x: x - width / 2, y: y - height, width, height };
}

const empty = (code, message, extra = {}) => ({
  candidates: [], diagnostics: { code, message, ...extra },
});

/**
 * pixels: original RGBA pixels (ImageData.data), dimensions in pixels.
 * region: normalized {x,y,w,h}, explicitly chosen by the user for FEET.
 * target: normalized foot target. bodyHeight: fraction of image height.
 * aspect: display width / height; defaults to pixels' width / height.
 * subjectBox: optional trusted detection, frozen with these pixels in view
 * coordinates. Never pass an example/manual box or a box from another crop.
 * Candidates are distinct, ranked references, not promises of a safe location.
 */
export function planStandingPositions({ pixels, width, height, region, target, bodyHeight, limit = 3, aspect,
  poseId, poseMirrored = false, sourceKey = '', zoomRevision = 0, zoomPending = false, subjectBox = null } = {}) {
  if (zoomPending) return empty('zoom_pending', '等倍率调节完成后，再比较当前背景站位。');
  if (poseId && !getPoseGeometry(poseId,{mirrored:poseMirrored})) return empty('invalid_pose','当前姿势轮廓无效，请重新选择姿势。');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || !ArrayBuffer.isView(pixels) || pixels.BYTES_PER_ELEMENT !== 1
    || !Number.isSafeInteger(width * height * 4) || pixels.length < width * height * 4) {
    return empty('invalid_image', '背景图像尚未准备好，请重新选取背景。');
  }
  if (!region || ![region.x, region.y, region.w, region.h].every(Number.isFinite) || region.w <= 0 || region.h <= 0) {
    return empty('invalid_region', '请先框选一个有面积的脚点区域。');
  }
  if (!target || ![target.x, target.y].every(Number.isFinite) || target.x < 0 || target.x > 1 || target.y < 0 || target.y > 1) {
    return empty('invalid_target', '请先确定画面中的构图目标。');
  }
  if (!Number.isFinite(bodyHeight) || bodyHeight <= 0 || bodyHeight >= 1) {
    return empty('invalid_height', '人物高度比例需要大于 0 且小于整幅画面。');
  }
  const imageAspect = aspect === undefined ? width / height : aspect;
  if (!Number.isFinite(imageAspect) || imageAspect <= 0) return empty('invalid_aspect', '画面宽高比无效。');
  if (!Number.isFinite(limit) || limit < 1) return empty('empty_limit', '没有请求候选站位。');
  limit = clamp(Math.floor(limit), 1, 12);
  const outline = poseId ? computePoseFootprint({poseId,x:0,y:0,height:bodyHeight,aspect:imageAspect,mirrored:poseMirrored}) : null;
  const bodyWidth = outline?.width ?? bodyHeight * BODY_WIDTH_TO_HEIGHT / imageAspect;
  const extent = outline ? {left:-outline.x,right:outline.x+outline.width,above:-outline.y,below:outline.y+outline.height}
    : {left:bodyWidth/2,right:bodyWidth/2,above:bodyHeight,below:0};
  // Intersect the selected foot region with the *actual authored* pose envelope.
  // Asymmetric poses have different left/right margins; mirror swaps them.
  const minX = Math.max(region.x, extent.left + FRAME_MARGIN, 0);
  const maxX = Math.min(region.x + region.w, 1 - extent.right - FRAME_MARGIN, 1);
  const minY = Math.max(region.y, extent.above + FRAME_MARGIN, 0);
  const maxY = Math.min(region.y + region.h, 1 - extent.below - FRAME_MARGIN, 1);
  const bounds = { minX, maxX, minY, maxY };
  const regionInput={bodyHeight,aspect:imageAspect,poseId,poseMirrored,subjectBox};
  const subjectOcclusionAvailable=Boolean(assessTargetBackgroundOcclusion({...regionInput,target}));
  const diagnostics = {
    aspect: imageAspect, bodyWidth, bounds,
    method: poseId ? 'authored-pose-head-shoulder-and-outline-edges' : 'sampled-luminance-and-local-edges', scoreWeights: SCORE_WEIGHTS,
    poseId:poseId || null, poseMirrored:Boolean(poseMirrored), sourceKey, zoomRevision,
    footprintExtent:extent, rankingOnly:true, visiblePixelsOnly:true, semanticLabels:false, depthMeasured:false, groundSafetyAssessed:false,
    subjectOcclusionAvailable,occlusionThreshold:BACKGROUND_OCCLUSION_THRESHOLD,
    sampledCandidates: 0, rejectedForTransparency: 0, rejectedForOcclusion: 0,
  };
  if (minX > maxX || minY > maxY) {
    return empty('no_space', '这个区域放不下完整人物轮廓。请扩大脚点区域，或减小人物高度。', diagnostics);
  }

  const xs = new Set([clamp(target.x, minX, maxX)]);
  const ys = new Set([clamp(target.y, minY, maxY)]);
  for (let i = 0; i <= 20; i++) xs.add(minX + (maxX - minX) * i / 20);
  for (let i = 0; i <= 12; i++) ys.add(minY + (maxY - minY) * i / 12);
  const ranked = [];
  for (const x of xs) for (const y of ys) {
    diagnostics.sampledCandidates++;
    const foot = { x, y, height: bodyHeight };
    const occlusion=assessTargetBackgroundOcclusion({...regionInput,target:foot});
    if(occlusion?.occluded){diagnostics.rejectedForOcclusion++;continue;}
    const background = analyzeTargetBackground({pixels,width,height,target:foot,bodyHeight,aspect:imageAspect,poseId,poseMirrored});
    if (!background) { diagnostics.rejectedForTransparency++; continue; }
    const distance = Math.hypot(x - target.x, y - target.y);
    const compositionFit = 1 - clamp(distance / 0.65, 0, 1);
    const rawScore = 100 * (SCORE_WEIGHTS.background * background.backgroundFit + SCORE_WEIGHTS.composition * compositionFit);
    const backgroundReason = background.backgroundFit > 0.72 ? '当前头肩区域的可见像素中，边缘和明暗变化较少'
      : background.backgroundFit > 0.4 ? '当前头肩区域的可见像素干扰适中' : '当前头肩区域的可见像素仍有较多边缘或明暗变化';
    const compositionReason = distance < 0.08 ? '接近所选构图目标' : '在所选区域内兼顾背景与构图';
    const footprint = poseId ? computePoseFootprint({poseId,...foot,aspect:imageAspect,mirrored:poseMirrored}) : null;
    const outlineReason = background.strongOutlineFraction > .15 ? '；头肩轮廓附近仍有明显边缘，请现场确认' : '';
    ranked.push({ ...foot, score: Math.round(rawScore), reason: `${backgroundReason}；${compositionReason}${outlineReason}。`, rawScore, distance,
      footprint, template:footprint?.template || null, metrics:{...background,compositionFit,distance,occlusion},
      provenance:{sourceKey,zoomRevision,poseId:poseId || null,poseMirrored:Boolean(poseMirrored)},
    });
  }
  ranked.sort((a, b) => b.rawScore - a.rawScore || a.distance - b.distance || a.y - b.y || a.x - b.x);
  const selected = [];
  // Distinct alternatives, rather than three adjacent pixels of the same pose.
  const minSeparation = Math.max(4, Math.min(width, height) * 0.07, bodyHeight * height * 0.3);
  for (const candidate of ranked) {
    if (selected.some((prior) => Math.hypot((prior.x - candidate.x) * width, (prior.y - candidate.y) * height) < minSeparation)) continue;
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  if(!selected.length&&diagnostics.rejectedForOcclusion)return empty('background_occluded',
    '未找到无遮挡且像素完整的头肩区域。请让人物暂时移开，重新选取背景后再规划。',diagnostics);
  if (!selected.length) return empty('no_background_samples', '这个区域没有足够的可读取背景像素，请换一个区域。', diagnostics);
  return {
    candidates: selected.map(({ rawScore, distance, ...candidate }) => candidate),
    diagnostics: {
      ...diagnostics, code: 'ok',
      message: `${diagnostics.rejectedForOcclusion?'已跳过被现有人物明显遮挡的头肩区域。':''}仅在你圈选的脚点区域内比较当前可见像素与构图；未做人物分割，不判断地面是否可站立。`,
    },
  };
}
