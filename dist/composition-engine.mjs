/**
 * One view-coordinate contract for shot, authored pose, subject and background.
 * This is a geometric/pixel engine, not semantic scene understanding, a depth
 * estimator, a walkability detector or an aesthetic model. Its checks explain
 * their evidence and keep missing evidence distinct from a successful check.
 */
import { getPose, renderPoseSvg } from './poses.mjs';
import { SHOTS, targetForShot, getShotTemplateTransform, assessShotComposition } from './shots.mjs';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const finiteBox = b => Boolean(b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0);
const finitePoint = p => Boolean(p && [p.x, p.y].every(Number.isFinite));
const inFrame = p => finitePoint(p) && p.visible !== false && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const poseCache = new Map();
const BODY_SPAN = 470, SVG_WIDTH = 200, SVG_HEIGHT = 500, CENTER_X = 100, FEET_Y = 480;
const BODY_RANGES = Object.freeze({ extreme_wide: [.04, .16], wide: [.14, .42], full: [.55, .9] });
// Conservative geometric veto, not a segmentation confidence or learned limit.
export const BACKGROUND_OCCLUSION_THRESHOLD = .25;
const boundaries = points => ({
  left: Math.min(...points.map(p => p.x - (p.r || 0))),
  right: Math.max(...points.map(p => p.x + (p.r || 0))),
  top: Math.min(...points.map(p => p.y - (p.r || 0))),
  bottom: Math.max(...points.map(p => p.y + (p.r || 0))),
});
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const freezeBox = b => Object.freeze(b);

/**
 * Read the public renderer's explicit data-joint/data-part geometry once.
 * Only the authored M/L skeleton paths are accepted; decorative gaze arrows,
 * props and facial markings do not enlarge a person's usable footprint.
 * This avoids maintaining a second, divergent catalog of pose dimensions.
 */
export function getPoseGeometry(poseId, { mirrored = false } = {}) {
  if (!getPose(poseId)) return null;
  const key = `${poseId}:${Boolean(mirrored)}`;
  if (poseCache.has(key)) return poseCache.get(key);
  const svg = renderPoseSvg(poseId);
  const points = [], joints = [];
  const convertX = x => mirrored ? SVG_WIDTH - x : x;
  for (const match of svg.matchAll(/<circle\b[^>]*>/g)) {
    const a = attrs(match[0]);
    if (!a['data-joint'] && a['data-part'] !== 'head') continue;
    const x = Number(a.cx), y = Number(a.cy), r = Number(a.r);
    if (![x, y, r].every(Number.isFinite)) return null;
    const p = { x: convertX(x), y, r: r + (a['data-part'] === 'head' ? 1.8 : 0), name: a['data-joint'] || 'head' };
    points.push(p);
    if (a['data-joint']) joints.push(p);
  }
  for (const match of svg.matchAll(/<path\b[^>]*>/g)) {
    const a = attrs(match[0]);
    if (!/^(?:spine|shoulders|hips|foot|(?:leg|arm|hand)-\d+)$/.test(a['data-part'] || '')) continue;
    if (!a.d || /[^ML\d\s.,+\-]/i.test(a.d)) return null;
    const values = a.d.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)/g)?.map(Number) || [];
    if (values.length % 2) return null;
    for (let i = 0; i < values.length; i += 2) points.push({x:convertX(values[i]), y:values[i+1], r:1.8, name:a['data-part']});
  }
  if (!points.length || joints.length !== 13) return null;
  const head = points.find(p => p.name === 'head');
  const shoulders = joints.filter(p => p.name.startsWith('shoulder-'));
  if (!head || shoulders.length !== 2) return null;
  const upper = boundaries([head, ...shoulders.map(p => ({...p, r:16}))]);
  upper.top -= 6; upper.bottom += 28;
  const result = Object.freeze({
    poseId, mirrored:Boolean(mirrored), bodySpan:BODY_SPAN,
    points:Object.freeze(points.map(Object.freeze)), joints:Object.freeze(joints.map(Object.freeze)),
    bounds:freezeBox(boundaries(points)), head: Object.freeze({...head}),
    shoulders:Object.freeze(shoulders.map(p => Object.freeze({...p}))),
    headShoulders:freezeBox(upper),
    method:'authored-svg-joints-and-linear-skeleton',
  });
  poseCache.set(key, result);
  return result;
}

function projectBounds(bounds, template) {
  const x = template.left + bounds.left / SVG_WIDTH * template.width;
  const y = template.top + bounds.top / SVG_HEIGHT * template.height;
  return {x, y, width:(bounds.right-bounds.left)/SVG_WIDTH*template.width, height:(bounds.bottom-bounds.top)/SVG_HEIGHT*template.height};
}

/** Full-body, foot-anchored outline. height excludes the SVG padding. */
export function computePoseFootprint({poseId, x, y, height, aspect = .75, mirrored = false} = {}) {
  if (![x,y,height,aspect].every(Number.isFinite) || height <= 0 || aspect <= 0) return null;
  const geometry = getPoseGeometry(poseId,{mirrored});
  if (!geometry) return null;
  const template = {
    left:x-CENTER_X/BODY_SPAN*height/aspect, top:y-FEET_Y/BODY_SPAN*height,
    width:SVG_WIDTH/BODY_SPAN*height/aspect, height:SVG_HEIGHT/BODY_SPAN*height,
  };
  return {
    ...projectBounds(geometry.bounds,template), template,
    headShoulders:projectBounds(geometry.headShoulders,template),
    poseId, mirrored:Boolean(mirrored), source:'authored-reference',
  };
}

/**
 * Clamp a full-body reference using this pose's actual envelope. For tighter
 * shots only the anchor is clamped: deliberately cropped lower limbs are not
 * forced back into frame. An impossible footprint is reported, never shrunk.
 */
export function constrainPoseTarget({shot = 'wide', target, aspect = .75, poseId, mirrored = false, margin = .02} = {}) {
  const config = SHOTS.find(s => s.id === (typeof shot === 'string' ? shot : shot?.id));
  if (!config || !Number.isFinite(aspect) || aspect <= 0 || !finitePoint(target)) return {target, fits:false, changed:false, reason:'invalid_input', footprint:null, bounds:null};
  margin = Number.isFinite(margin) ? clamp(margin,0,.2) : .02;
  let bounds = {minX:margin,maxX:1-margin,minY:margin,maxY:1-margin};
  const requestedHeight = target.bodyHeight ?? target.height ?? config.recommendedBodyHeight;
  const g = config.kind === 'person' ? getPoseGeometry(poseId,{mirrored}) : null;
  if (config.kind === 'person' && Number.isFinite(requestedHeight) && requestedHeight > 0) {
    const b = g?.bounds || {left:0,right:SVG_WIDTH,top:10,bottom:FEET_Y};
    bounds = {
      minX:margin+(CENTER_X-b.left)/BODY_SPAN*requestedHeight/aspect,
      maxX:1-margin-(b.right-CENTER_X)/BODY_SPAN*requestedHeight/aspect,
      minY:margin+(FEET_Y-b.top)/BODY_SPAN*requestedHeight,
      maxY:1-margin-(b.bottom-FEET_Y)/BODY_SPAN*requestedHeight,
    };
  }
  const fits = bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY;
  const next = {...target,
    x:fits ? clamp(target.x,bounds.minX,bounds.maxX) : .5,
    y:bounds.minY<=bounds.maxY ? clamp(target.y,bounds.minY,bounds.maxY) : .5,
  };
  return {target:next, fits, changed:next.x!==target.x||next.y!==target.y, bounds,
    footprint:g ? computePoseFootprint({poseId,x:next.x,y:next.y,height:requestedHeight,aspect,mirrored}) : null,
    reason:fits ? config.kind==='person' ? 'pose-envelope' : 'face-anchor-only' : 'pose-does-not-fit',
  };
}

function usablePixels({pixels,width,height} = {}) {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 2 && height >= 2
    && Number.isSafeInteger(width*height*4) && ArrayBuffer.isView(pixels)
    && pixels.BYTES_PER_ELEMENT === 1 && pixels.length >= width*height*4;
}

function targetHeadShoulderRegion({target,bodyHeight,aspect,poseId,poseMirrored=false}) {
  if(!finitePoint(target)||!Number.isFinite(bodyHeight)||bodyHeight<=0||!Number.isFinite(aspect)||aspect<=0)return null;
  const footprint=poseId?computePoseFootprint({poseId,x:target.x,y:target.y,height:bodyHeight,aspect,mirrored:poseMirrored}):null;
  if(poseId&&!footprint)return null;
  const bodyWidth=bodyHeight*.42/aspect;
  const roi=footprint?.headShoulders||{x:target.x-bodyWidth*.62,y:target.y-bodyHeight*1.04,width:bodyWidth*1.24,height:bodyHeight*.56};
  const left=clamp(roi.x,0,1),right=clamp(roi.x+roi.width,0,1);
  const top=clamp(roi.y,0,1),bottom=clamp(roi.y+roi.height,0,1);
  return right>left&&bottom>top?{x:left,y:top,width:right-left,height:bottom-top}:null;
}

/**
 * subjectBox must be a trusted detection in this same frozen/current view.
 * A box is a conservative proxy: significant overlap vetoes a background
 * conclusion, but a clear result does not prove segmentation or no occluders.
 */
export function assessTargetBackgroundOcclusion({subjectBox,target,bodyHeight,aspect,poseId,poseMirrored=false} = {}) {
  if(!finiteBox(subjectBox)||subjectBox.visible===false)return null;
  const roi=targetHeadShoulderRegion({target,bodyHeight,aspect,poseId,poseMirrored});
  if(!roi)return null;
  const left=clamp(subjectBox.x,0,1),right=clamp(subjectBox.x+subjectBox.width,0,1);
  const top=clamp(subjectBox.y,0,1),bottom=clamp(subjectBox.y+subjectBox.height,0,1);
  if(right<=left||bottom<=top)return null;
  const overlapWidth=Math.max(0,Math.min(roi.x+roi.width,right)-Math.max(roi.x,left));
  const overlapHeight=Math.max(0,Math.min(roi.y+roi.height,bottom)-Math.max(roi.y,top));
  const overlapRatio=clamp(overlapWidth*overlapHeight/(roi.width*roi.height),0,1);
  return {occluded:overlapRatio>=BACKGROUND_OCCLUSION_THRESHOLD,overlapRatio,threshold:BACKGROUND_OCCLUSION_THRESHOLD,
    headShoulderBox:roi,subjectBox:{x:left,y:top,width:right-left,height:bottom-top},
    method:'detected-box-overlap-with-target-head-shoulders',segmentation:false};
}

/** Sample currently visible pixels in a prospective head/shoulder region. */
export function analyzeTargetBackground({pixels,width,height,target,bodyHeight,aspect,poseId,poseMirrored=false} = {}) {
  if (!usablePixels({pixels,width,height}) || !finitePoint(target) || !Number.isFinite(bodyHeight) || bodyHeight<=0) return null;
  aspect = aspect ?? width/height;
  if (!Number.isFinite(aspect)||aspect<=0) return null;
  const g = poseId ? getPoseGeometry(poseId,{mirrored:poseMirrored}) : null;
  if (poseId && !g) return null;
  const roi=targetHeadShoulderRegion({target,bodyHeight,aspect,poseId,poseMirrored});
  if(!roi)return null;
  const left=roi.x,right=roi.x+roi.width,top=roi.y,bottom=roi.y+roi.height;
  const x0=Math.floor(left*(width-1)),x1=Math.ceil(right*(width-1));
  const y0=Math.floor(top*(height-1)),y1=Math.ceil(bottom*(height-1));
  const cols=Math.min(17,Math.max(2,x1-x0+1)),rows=Math.min(17,Math.max(2,y1-y0+1));
  const sample = (x,y) => {
    x=clamp(Math.round(x),0,width-1);y=clamp(Math.round(y),0,height-1);
    const nx=x<width-1?x+1:x-1,ny=y<height-1?y+1:y-1;
    const indices=[(y*width+x)*4,(y*width+nx)*4,(ny*width+x)*4];
    if (indices.some(i=>pixels[i+3]<240)) return null;
    const l=indices.map(i=>(.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2])/255);
    return {value:l[0],edge:(Math.abs(l[0]-l[1])+Math.abs(l[0]-l[2]))/2};
  };
  let sum=0,squared=0,edgeSum=0,valid=0;
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++) {
    const s=sample(x0+(x1-x0)*col/(cols-1),y0+(y1-y0)*row/(rows-1));
    if(!s)continue;sum+=s.value;squared+=s.value*s.value;edgeSum+=s.edge;valid++;
  }
  const coverage=valid/(cols*rows);
  if(!valid||coverage<.9)return null;
  let outlineSum=0,outlineValid=0,strongOutline=0,outlineRequested=0;
  if(g) {
    const points=[];
    for(let i=0;i<20;i++) {const a=i*Math.PI/10;points.push({x:g.head.x+g.head.r*Math.cos(a),y:g.head.y+g.head.r*Math.sin(a)});}
    const [a,b]=g.shoulders;
    for(let i=0;i<=12;i++)points.push({x:a.x+(b.x-a.x)*i/12,y:a.y+(b.y-a.y)*i/12});
    for(const p of points) {
      const x=target.x+(p.x-CENTER_X)/BODY_SPAN*bodyHeight/aspect;
      const y=target.y+(p.y-FEET_Y)/BODY_SPAN*bodyHeight;
      if(x<0||x>1||y<0||y>1)continue;
      outlineRequested++;
      const s=sample(x*(width-1),y*(height-1));
      if(!s)continue;outlineSum+=s.edge;outlineValid++;if(s.edge>.18)strongOutline++;
    }
    if(outlineRequested && outlineValid/outlineRequested<.9)return null;
  }
  const mean=sum/valid,variance=Math.max(0,squared/valid-mean*mean),edge=edgeSum/valid;
  const outlineEdge=outlineValid?outlineSum/outlineValid:edge;
  const strongOutlineFraction=outlineValid?strongOutline/outlineValid:0;
  const outlineClutter=.65*clamp(outlineEdge/.18,0,1)+.35*clamp(strongOutlineFraction/.35,0,1);
  const clutter=g
    ? .35*clamp(edge/.18,0,1)+.4*clamp(Math.sqrt(variance)/.28,0,1)+.25*outlineClutter
    : .55*clamp(edge/.18,0,1)+.45*clamp(Math.sqrt(variance)/.28,0,1);
  return {backgroundFit:1-clutter,mean,variance,edge,outlineEdge,strongOutlineFraction,coverage,
    headShoulderBox:{x:left,y:top,width:right-left,height:bottom-top},
    method:g?'pose-head-shoulder-luminance-and-outline-edges':'sampled-luminance-and-local-edges',
    visiblePixelsOnly:true,segmentation:false,semanticLabels:false,depthMeasured:false,groundSafetyAssessed:false,
  };
}

function zoomAdviceFor({box,target,zoom,measurement}) {
  const wanted=target.bodyHeight??target.faceHeight??target.height;
  // Reuse the shot assessment's measurement gate. A clipped face or a body
  // near the frame edge may have a finite box but no reliable size evidence.
  if(!measurement||measurement.action==='framing'||!Number.isFinite(measurement.heightRatio)||measurement.sizeAligned===null)return null;
  if(!finiteBox(box)||!Number.isFinite(wanted)||wanted<=0||wanted>1||!Number.isFinite(zoom.value)||zoom.value<=0||zoom.pending)return null;
  if(box.x<0||box.y<0||box.x+box.width>1||box.y+box.height>1)return null;
  const factor=wanted/box.height;
  const rangeMin=Number.isFinite(zoom.min)?zoom.min:1;
  const rangeMax=Number.isFinite(zoom.max)?zoom.max:zoom.value;
  if(rangeMin<=0||rangeMax<rangeMin)return null;
  const extent=Math.max(Math.abs(box.x-.5),Math.abs(box.x+box.width-.5),Math.abs(box.y-.5),Math.abs(box.y+box.height-.5));
  // Tight shots deliberately crop the BODY, but must not zoom a measurable
  // FACE out of view. Preserve the measured kind's envelope in every shot.
  const framingLimit=extent>0?.48/extent:Infinity;
  const desired=zoom.value*factor;
  const maximum=Math.min(rangeMax,zoom.value*framingLimit);
  if(maximum<rangeMin)return null;
  const feasible=clamp(desired,rangeMin,maximum);
  const limitedByFrame=desired>zoom.value*framingLimit+1e-8;
  const limitedByRange=desired<rangeMin||desired>rangeMax;
  const limitNote=limitedByFrame?'当前受主体边缘限制，不能仅靠倍率达到目标占比；先调整取景位置。'
    :limitedByRange?'受倍率范围限制，当前估算不能完全达到目标占比。':'';
  return {estimated:true,desired,feasible,limitedByFrame,limitedByRange,desiredHeight:wanted,observedHeight:box.height,
    note:`${limitNote}按当前画面比例估算；调节后需重新检测。倍率不会改变拍摄位置和透视。`};
}

/**
 * Inputs are already in the *displayed crop* (after mirror), never raw sensor
 * coordinates. background must carry matching sourceKey AND zoomRevision.
 * A consistent result concerns measured geometry only, not a stable capture,
 * actual pose completion, walkability, exposure accuracy or artistic quality.
 */
export function assessFrameCoordination({shot='wide',target,aspect=.75,poseId,poseMirrored=false,
  point=null,box=null,observedKind,observationOrigin='detected',zoom={},sourceKey='',zoomRevision=0,background=null} = {}) {
  const config=SHOTS.find(s=>s.id===(typeof shot==='string'?shot:shot?.id));
  const checks=[];
  const add=(code,state,title,detail,priority=0,evidence=null)=>{checks.push({code,state,title,detail,priority,evidence});};
  const finish=(extra={})=>{
    const warnings=checks.filter(c=>c.state==='warn').sort((a,b)=>b.priority-a.priority);
    const unknown=checks.some(c=>c.state==='unknown');
    return {checks,warnings,primary:warnings[0]||checks.find(c=>c.state==='unknown')||null,
      status:warnings.length?'needs-adjustment':unknown?'reference-only':'geometry-consistent',
      summary:warnings[0]?.title||(unknown?'部分条件仍需确认':'当前几何关系接近参考'),
      sourceKey,zoomRevision,artisticScore:null,...extra};
  };
  if(!config||!Number.isFinite(aspect)||aspect<=0){add('invalid_context','unknown','等待有效取景信息','景别或画幅未准备好。');return finish({geometry:null,zoomAdvice:null});}
  target=target||targetForShot({shot:config.id});
  if(!inFrame(target)){add('invalid_target','warn','先把参考位置放进画面','目标锚点不在当前取景范围内。',100);return finish({geometry:null,zoomAdvice:null});}
  const pose=getPose(poseId),g=getPoseGeometry(poseId,{mirrored:poseMirrored});
  const transform=getShotTemplateTransform({shot:config.id,target,aspect});
  const footprint=g?projectBounds(g.bounds,transform):null;
  const headShoulders=g?projectBounds(g.headShoulders,transform):null;
  const geometry={shotId:config.id,kind:config.kind,anchor:config.anchor,target:{...target},aspect,poseId:pose?.id||null,
    footprint,template:transform,headShoulders,poseOrigin:'authored-reference',intentionallyCropped:config.kind!=='person'};
  if(!g)add('pose_geometry','unknown','姿势轮廓尚未准备好','等待已选择姿势的关节参考，暂不判断动作占用的宽度。');
  else {
    if(!pose.shotTags.includes(config.id))add('pose_shot','warn','这个动作不在当前景别推荐中','选择适合当前景别的动作，或自行确认重要手势是否仍在画面中。',35);
    if(config.kind==='person') {
      const clipped=footprint.x<.015||footprint.y<.015||footprint.x+footprint.width>.985||footprint.y+footprint.height>.985;
      add('pose_frame',clipped?'warn':'pass',clipped?'给当前姿势留出完整空间':'姿势轮廓留在画面内',
        clipped?'按当前动作的头、手、脚轮廓计算，参考靠近或越过边缘；移回参考或减小人物占比。':'按实际参考关节和轮廓检查了画幅与人物占比；这不是对真人动作的验证。',clipped?95:0,{footprint});
    } else add('intentional_crop','pass','按当前景别保留下半身裁切',config.cropHint+' 脸框无法验证膝、腰或手势裁切。');
    if(pose.needsProp)add('pose_prop','unknown',`确认现场有${pose.needsProp}`,'道具条件来自姿势模板，当前算法没有识别道具是否存在。');
  }
  if(config.kind==='person') {
    const wanted=target.bodyHeight??target.height;
    const range=BODY_RANGES[config.id];
    if(!Number.isFinite(wanted)||wanted<=0||wanted>=1)add('shot_scale','warn','调整有效人物占比','完整人物的参考高度应小于整幅画面。',96);
    else if(wanted<range[0]||wanted>range[1])add('shot_scale','warn','人物占比与所选景别有差异',`当前参考约占高度 ${Math.round(wanted*100)}%；${config.name}采用 ${Math.round(range[0]*100)}–${Math.round(range[1]*100)}% 的项目参考范围，可保留自定义取景或改选景别。`,30,{height:wanted,referenceRange:range});
    else add('shot_scale','pass','人物占比符合当前景别参考',`当前参考高度 ${Math.round(wanted*100)}%；范围是产品约定，不是实际距离。`,0,{height:wanted});
  }
  let measuredBox=finiteBox(box)&&observationOrigin==='detected'?box:null;
  let measuredPoint=inFrame(point)?point:null;
  if(point?.visible===false){measuredBox=null;measuredPoint=null;add('observation_visible','unknown','主体已不在当前取景内','失效或裁剪外的主体点不能借旧检测框恢复为已对齐。');}
  if(observedKind&&observedKind!==config.kind){measuredBox=null;measuredPoint=null;add('observation_kind','unknown','等待当前景别的检测','旧的人脸/人体检测不能用于另一类锚点。');}
  if(zoom.pending){measuredBox=null;measuredPoint=null;add('zoom_pending','unknown','倍率调节后重新确认','设备倍率尚未回读完成，旧的位置和背景结果暂不参与判断。');}
  let measurement=null;
  if(!measuredPoint&&!measuredBox)add('subject_position','unknown','等待当前人物参考','暂无有效主体点，不判断当前位置是否对齐。');
  else {
    const assessment=assessShotComposition({shot:config.id,point:measuredPoint,box:measuredBox,target});
    measurement=assessment;
    if(assessment.action==='framing')add('subject_frame','warn',assessment.title,assessment.detail,90);
    else {
      add('subject_position',assessment.positionAligned?'pass':'warn',assessment.positionAligned?'人物位置接近参考':'人物位置还需要调整',assessment.detail,assessment.positionAligned?0:50,
        {point:measuredPoint,anchor:config.anchor});
      if(assessment.sizeAligned===null||!measuredBox)add('subject_size','unknown','尚未确认实际人物大小','没有可信检测框；手动点和示例点只提供位置。');
      else add('subject_size',assessment.sizeAligned?'pass':'warn',assessment.sizeAligned?'实际大小接近参考':'实际大小与景别参考不同',
        `${config.kind==='person'?'人物':'脸框'}约占高度 ${Math.round(measuredBox.height*100)}%，当前参考 ${Math.round((target.bodyHeight??target.faceHeight??target.height)*100)}%。`,assessment.sizeAligned?0:60,
        {observed:measuredBox.height,target:target.bodyHeight??target.faceHeight??target.height});
    }
  }
  if(['digital','photo'].includes(zoom.mode)&&Number.isFinite(zoom.value)&&zoom.value>1.01)add('digital_zoom','pass','数字裁剪与取景坐标共同计算',`${Number(zoom.value.toFixed(2))}× 裁剪保留的像素更少；不改变机位透视，也不保证小人物检测变准。`,0,{zoom:zoom.value});
  const sameBackground=background&&background.sourceKey===sourceKey&&background.zoomRevision===zoomRevision&&!zoom.pending;
  let metrics=null;
  if(background&&!sameBackground)add('background_source','unknown','背景参考需要更新','来源或倍率已改变，不沿用旧背景像素。');
  else if(config.kind==='person'&&sameBackground) {
    const regionInput={target,bodyHeight:target.bodyHeight??target.height,aspect,poseId,poseMirrored};
    const occlusion=assessTargetBackgroundOcclusion({...regionInput,subjectBox:measuredBox});
    if(occlusion?.occluded)add('background_occluded','unknown','头肩背景被当前人物遮挡',
      '可信人物框明显覆盖了参考头肩区域，脸部或衣服的纹理不能证明后方背景简洁。请让人物暂时移开，再重新选取背景。检测框只是保守遮挡提示，不是分割结果。',0,occlusion);
    else {
      metrics=analyzeTargetBackground({...background,...regionInput});
      if(!metrics)add('background_pixels','unknown','背景像素不足','头肩对应区域没有足够有效像素，暂不判断背景干扰。');
      else add('background_clutter',metrics.backgroundFit<.42?'warn':'pass',metrics.backgroundFit<.42?'头肩区域的可见像素干扰较多':'头肩区域的可见像素较简洁',
        '仅比较当前可见像素的明暗变化、局部及轮廓边缘；未分离人物和背景，不能推断被遮挡区域，也不识别道路、草地或地面安全。',metrics.backgroundFit<.42?45:0,metrics);
    }
  } else add('background_pixels','unknown',config.kind==='person'?'等待当前背景采样':'近景背景请对照画面确认',config.kind==='person'?'需要当前裁剪的像素才能比较头肩后的干扰。':'当前背景站位规划只用于完整人物景别；有意的身体裁切不会被当成错误。');
  return finish({geometry,backgroundMetrics:metrics,zoomAdvice:zoomAdviceFor({box:measuredBox,target,zoom,measurement})});
}
