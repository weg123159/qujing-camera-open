import { getCoverCrop, sourceBoxToView, targetFor, PRESETS } from './guide.mjs';
import { SHOTS, targetForShot, getShotTemplateTransform } from './shots.mjs';
import { POSES, getPose, recommendPoses, renderPoseSvg } from './poses.mjs';
import { planStandingPositions } from './planner.mjs';
import { CameraController } from './camera.mjs';
import { createGuidanceStabilizer } from './guidance-stability.mjs';
import { createOfflineManager } from './offline.mjs';
import { detectNativeHost, createNativePhotoSaver } from './native-bridge.mjs';
import { getZoomCrop, pointToCropView } from './zoom-geometry.mjs';
import { createZoomMotion } from './zoom-motion.mjs';
import { constrainPoseTarget, assessFrameCoordination } from './composition-engine.mjs';
import { createPhotoWorkbench } from './photo-workbench.mjs';
import { applyStylePixels, isStyleIdentity } from './photo-style.mjs';

const $ = id => document.getElementById(id);
const $$ = q => [...document.querySelectorAll(q)];
const frame = $('viewfinder');
const canvas = $('previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const video = $('cameraVideo');
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const state = {
  source: 'demo', preset: 'thirds', side: 'right', aspect: .75, grid: true,
  image: null, anchor: { x: .622, y: .86 }, box: null, mirrored: false,
  crop: null, zoom: 2, panX: .5, panY: .5, analysis: null,
  operation: 0, manualRevision: 0, cameraPending: false, busy: false, encoding: false,
  timer: false, countdownId: 0, photoURL: null, inputURL: null,
  portrait: false, faceCount: 0, detectionPending: false, lastCameraStatus: null,
  kind: 'person', actor: 'camera', bodyHeight: .20, personCount: 0, planTarget: null,
  shot: 'wide', scene: 'travel', poseId: null, poseFlipped: false, poseVisible: true, poseOpacity: .70,
  manualTarget: null, editingReference: false, referencePosition: null, sampleAnchor: true, morePoses: false,
  observation: null, tracking: null, photoBlob: null, sharing: false,
  liveDigitalZoom: 1, zoomRevision: 0, nativeSaving: false,
  shootMode: 'guide', acceptedReading: null, coordination: null,
};
const planner = { region: null, candidates: [], selected: -1, pixels: null, operation: 0, height: .3, aspect: .75 };
let toastTimer = 0;
const dialogOrigins = new WeakMap();
const stabilizer = createGuidanceStabilizer();
let guidanceExpiryTimer = 0;
let installPrompt = null;
let drag = null;
let pressStarted = false;
let importGeneration = 0;
let cameraZoom = {supported:false,mode:'unavailable',min:1,max:1,step:0,value:1,pending:false,error:null};
let cameraExposure = {supported:false,value:null,pending:false};
let workbench = null;
let zoomMotion = null;
let zoomFrameId = 0;
let zoomTransactionActive = false;
let lastZoomGuidanceAt = 0;
let presetSignature = '';
let coordinationSignature = '';
let pinch = null;
let pinching = false;
const activePointers = new Map();
const dialogStack = [];
const nativeHost = detectNativeHost();
const nativeSaver = nativeHost ? createNativePhotoSaver({host:nativeHost}) : null;
const demoImage = new Image();
const notes = Object.fromEntries(PRESETS.map(p => [p.id, p.description]));

function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4400);
}

function statusMessage(text, show = true) {
  $('cameraStatus').textContent = text;
  $('cameraStatus').hidden = !show;
}

const camera = new CameraController({
  video,
  onFrame(data) {
    if (state.source !== 'camera' || zoomFrameId || (data.kind && data.kind !== state.kind)) return;
    state.sampleAnchor = false;
    state.observation = data;
    state.anchor = data.point;
    state.box = data.box;
    state.faceCount = data.faceCount;
    state.personCount = data.personCount || 0;
    state.detectionPending = false;
    state.mirrored = data.mirrored;
    video.classList.toggle('mirrored', state.mirrored);
    updateGuidance();
  },
  onStatus(data) {
    if (data.state === 'stopped') return;
    if (state.source !== 'camera' && !state.cameraPending) return;
    state.lastCameraStatus = data;
    statusMessage(data.message, data.state !== 'ready');
    state.detectionPending = data.state === 'detecting';
    if (data.state === 'error' && state.source === 'camera' && !camera.running && !state.cameraPending) {
      state.anchor = null; state.box = null;
      $('shutterBtn').disabled = true;
      $('switchBtn').disabled = true;
      $('cameraBtn').querySelector('span').textContent = '重新开启相机';
      $('viewNotice').textContent = data.message;
      $('viewNotice').hidden = false;
    }
    updateGuidance();
  },
  onZoom(data) {
    const previous=cameraZoom;
    cameraZoom=data;
    if(state.source==='camera' && (data.value!==previous.value || data.pending!==previous.pending)) {
      state.observation=null;state.anchor=null;state.box=null;state.acceptedReading=null;
      ++state.zoomRevision;stabilizer.reset();workbench?.invalidate();
      const now=performance.now();
      draw({guidance:!data.pending||now-lastZoomGuidanceAt>80});
      if(!data.pending||now-lastZoomGuidanceAt>80)lastZoomGuidanceAt=now;
    }
    if(!data.pending&&!cameraExposure.pending)zoomTransactionActive=false;
    syncZoomUI();
  },
  onExposure(data) {
    const previous=cameraExposure;
    cameraExposure=data;
    if(state.source==='camera'&&(data.value!==previous.value||data.pending!==previous.pending)) {
      workbench?.invalidate();
      if(data.pending){state.observation=null;state.anchor=null;state.box=null;state.acceptedReading=null;stabilizer.reset();}
      updateGuidance();
    }
    workbench?.refreshExposure();syncZoomUI();
  },
});

function controlsPending() {return Boolean(cameraZoom.pending||cameraExposure.pending);}
function sourceKey() {
  const c=currentCrop();
  const cropKey=c?[c.sx,c.sy,c.sw,c.sh].map(v=>Number(v.toFixed(3))).join(','):'none';
  return `${state.operation}:${state.source}:${state.kind}:${state.aspect}:${camera.facing}:${state.mirrored}:${state.zoomRevision}:${cropKey}`;
}
function zoomConfig() {
  if(state.source!=='camera')return {min:1,max:3,step:.01,value:state.zoom,mode:'photo',pending:Boolean(zoomFrameId),requested:zoomMotion?.getState().target};
  if(cameraZoom.supported)return {...cameraZoom,mode:'track',step:cameraZoom.step||.01};
  return {min:1,max:6,step:.01,value:state.liveDigitalZoom,mode:'digital',pending:Boolean(zoomFrameId),requested:zoomMotion?.getState().target};
}
function zoomLabel(value) {return `${Number(Number(value).toFixed(2))}×`;}
function zoomSliderValue(value,z) {return z.max>z.min?Math.round(Math.log(clamp(value,z.min,z.max)/z.min)/Math.log(z.max/z.min)*1000):0;}
function zoomFromSlider(value,z) {return z.min*Math.exp(Math.log(z.max/z.min)*value/1000);}
function syncZoomUI() {
  const z=zoomConfig();
  const available=(state.source==='camera'?camera.running&&!state.cameraPending:Boolean(state.image?.naturalWidth))&&!state.encoding;
  const values=[...new Set([z.min,...[1,2,3,5].filter(v=>v>=z.min&&v<=z.max)])].slice(0,4);
  const signature=values.join('|');
  if(presetSignature!==signature) {
    presetSignature=signature;
    const fragment=document.createDocumentFragment();
    for(const value of values){const button=document.createElement('button');button.dataset.magnification=String(value);button.textContent=zoomLabel(value);button.setAttribute('aria-label',`倍率 ${zoomLabel(value)}`);fragment.append(button);}
    $('zoomPresets').replaceChildren(fragment);
  }
  for(const button of $('zoomPresets').children){button.disabled=!available;button.setAttribute('aria-pressed',Math.abs(Number(button.dataset.magnification)-z.value)<.025);}
  $('openZoomBtn').disabled=!available;$('zoomCurrent').textContent=zoomLabel(z.value);
  $('zoomMode').textContent=z.mode==='track'?'设备变焦':z.mode==='digital'?'数字裁剪':'照片裁剪';
  const requested=z.pending&&Number.isFinite(z.requested)?z.requested:z.value;
  $('magnificationValue').textContent=z.mode==='track'&&z.pending?`${zoomLabel(z.value)} → ${zoomLabel(requested)}`:zoomLabel(z.value);
  const slider=$('magnificationSlider');slider.value=zoomSliderValue(requested,z);slider.disabled=!available||z.max===z.min;
  slider.setAttribute('aria-valuetext',`${zoomLabel(requested)}${z.mode==='track'&&z.pending?'，设备调节中':''}`);
  $('magnificationRange').textContent=`${zoomLabel(z.min)} — ${zoomLabel(z.max)}`;
  $('zoomDescription').textContent=z.mode==='track'?'以设备返回的实际倍率为准，不代表全部为光学变焦。':z.mode==='digital'?'此镜头未开放设备倍率；数字裁剪与成片范围一致，放大后保留像素减少。':'裁剪当前照片；预览与成片范围一致，放大后保留像素减少。';
  $('zoomError').hidden=!cameraZoom.error||state.source!=='camera';$('zoomError').textContent=cameraZoom.error?.message||'';
  $('zoomSlider').value=state.zoom;$('zoomValue').textContent=zoomLabel(state.zoom);
  $('zoomBar').hidden=state.editingReference;
  if(state.source==='camera')$('shutterBtn').disabled=state.busy||state.cameraPending||!camera.running||controlsPending();
}
function closeInlineZoom() {$('zoomInline').hidden=true;$('openZoomBtn').setAttribute('aria-expanded','false');frame.classList.remove('zoom-expanded');}
function stopZoomMotion() {
  if(zoomFrameId)cancelAnimationFrame(zoomFrameId);
  zoomFrameId=0;zoomMotion=null;zoomTransactionActive=false;
}
function beginZoomTransaction() {
  if(zoomTransactionActive)return;
  zoomTransactionActive=true;cancelCountdown();clearPlan('倍率已改变，请按新画面确认站位。');
  state.editingReference=false;state.observation=null;state.acceptedReading=null;
  if(state.source==='camera'){state.anchor=null;state.box=null;}
  ++state.zoomRevision;stabilizer.reset();workbench?.invalidate();
}
function animateZoom(now) {
  if(!zoomMotion){zoomFrameId=0;return;}
  const motion=zoomMotion.step(now);
  if(state.source==='camera')state.liveDigitalZoom=motion.value;else state.zoom=motion.value;
  const full=motion.settled||now-lastZoomGuidanceAt>=90;
  draw({guidance:full});if(full)lastZoomGuidanceAt=now;
  if(motion.settled){zoomFrameId=0;zoomMotion=null;zoomTransactionActive=false;workbench?.invalidate();updateGuidance();}
  else zoomFrameId=requestAnimationFrame(animateZoom);
  syncZoomUI();
}
async function setMagnification(value) {
  const z=zoomConfig();
  if(!Number.isFinite(value)||state.encoding||state.cameraPending||state.nativeSaving)return;
  value=clamp(value,z.min,z.max);
  const current=z.pending&&Number.isFinite(z.requested)?z.requested:z.value;
  if(Math.abs(current-value)<.001)return;
  beginZoomTransaction();
  if(state.source==='camera'&&z.mode==='track') {
    const operation=state.operation;
    const success=await camera.setZoom(value);
    if(operation===state.operation&&!camera.getZoomState().pending)zoomTransactionActive=false;
    if(!success&&operation===state.operation&&!camera.getZoomState().pending) {
      const error=camera.getZoomState().error;if(error)toast(error.message);
    }
  } else {
    if(!zoomMotion)zoomMotion=createZoomMotion({value:z.value,min:z.min,max:z.max,timeConstantMs:matchMedia('(prefers-reduced-motion: reduce)').matches?0:60});
    zoomMotion.setTarget(value);
    if(!zoomFrameId){zoomMotion.step(performance.now());zoomFrameId=requestAnimationFrame(animateZoom);}
    syncZoomUI();
  }
}

function size() {
  return state.source === 'camera'
    ? { w: video.videoWidth, h: video.videoHeight }
    : { w: state.image?.naturalWidth || 0, h: state.image?.naturalHeight || 0 };
}

function currentCrop() {
  const { w, h } = size();
  if (!w || !h) return null;
  const base = getCoverCrop(w, h, state.aspect, 1);
  if (state.source === 'camera') return getZoomCrop(w,h,state.aspect,state.liveDigitalZoom);
  const cw = base.sw / state.zoom;
  const ch = base.sh / state.zoom;
  const cx = clamp(state.panX * w, cw / 2, w - cw / 2);
  const cy = clamp(state.panY * h, ch / 2, h - ch / 2);
  state.panX = cx / w; state.panY = cy / h;
  return { sx: cx - cw / 2, sy: cy - ch / 2, sw: cw, sh: ch };
}

function viewPoint(point) {
  if (!point) return null;
  const { w, h } = size();
  if (!w || !h) return null;
  const crop = currentCrop();
  if (!crop) return null;
  return pointToCropView(point,w,h,crop,state.mirrored);
}

function viewBox() {
  const { w, h } = size();
  return sourceBoxToView(state.box, w, h, state.aspect, 1, state.mirrored, currentCrop());
}

function gridPath(preset, side = state.side) {
  const third = 'M100 0V400M200 0V400M0 133.333H300M0 266.667H300';
  const flip = side === 'left';
  return ({
    thirds: third,
    center: 'M150 0V400M0 160H300',
    negative: `M${flip ? 81 : 219} 0V400M0 160H300`,
    golden: 'M114.6 0V400M185.4 0V400M0 152.8H300M0 247.2H300',
    symmetry: 'M150 0V400M80 35H220V365H80ZM0 266.667H300',
    diagonal: flip ? 'M0 0L300 400M0 400L150 200' : 'M300 0L0 400M300 400L150 200',
    leading: `M0 400L${flip ? 100 : 200} 180L300 400M30 400L${flip ? 100 : 200} 180L270 400`,
    frame: 'M45 52H255V348H45ZM60 68H240V332H60ZM150 52V68M150 332V348',
    wide: 'M0 133.333H300M0 266.667H300M100 246V286M200 246V286',
  })[preset] || third;
}

function shotConfig() { return SHOTS.find(shot => shot.id === state.shot); }
function currentTarget() {
  const target = targetForShot({shot:state.shot,preset:state.preset,side:state.side,manualTarget:state.manualTarget || state.planTarget});
  if (state.kind === 'person') {
    target.height = target.bodyHeight = state.bodyHeight;
    if (!state.manualTarget && !state.planTarget) target.y = Math.max(target.y, state.bodyHeight + .055);
  }
  return constrainPoseTarget({shot:state.shot,target,aspect:state.aspect,poseId:state.poseId,mirrored:state.poseFlipped}).target;
}

function syncSettings() {
  const shot = shotConfig();
  $$('[data-shot]').forEach(b => {const yes=b.dataset.shot===state.shot;b.classList.toggle('selected',yes);b.setAttribute('aria-pressed',yes);});
  $('shotDescription').textContent = shot.description;
  $('toolbarShot').textContent = shot.name;
  $('bodySettings').hidden = state.kind !== 'person';
  $('bodyHeight').value = Math.round(state.bodyHeight * 100);
  $('bodyHeightValue').textContent = `${Math.round(state.bodyHeight * 100)}%`;
  $('subjectLegend').textContent = state.kind === 'person' ? '人物脚点近似' : '脸部中心参考';
  $('targetLegend').textContent = state.manualTarget || state.planTarget ? '你摆放的参考' : '构图参考位置';
  frame.classList.toggle('body-mode', state.kind === 'person');
  $('sideSetting').hidden = ['center', 'symmetry'].includes(state.preset);
  $('compositionNote').textContent = notes[state.preset];
  $('toolbarComposition').textContent = PRESETS.find(p => p.id === state.preset)?.name;
  $$('[data-position]').forEach(b => {const yes=b.dataset.position===state.referencePosition;b.classList.toggle('selected',yes);b.setAttribute('aria-pressed',yes);});
  $$('[data-actor]').forEach(b => {const yes=b.dataset.actor===state.actor;b.classList.toggle('selected',yes);b.setAttribute('aria-pressed',yes);});
  frame.classList.toggle('placing-reference', state.editingReference);
  frame.style.touchAction = 'none';
  $('placeReferenceBtn').classList.toggle('selected', state.editingReference);
  $('placeReferenceBtn').setAttribute('aria-pressed', state.editingReference);
  $('placementAction').textContent = state.editingReference ? '正在摆放' : '拖动参考';
  $('placeReferenceBtn').setAttribute('aria-label', state.editingReference ? '站位：完成摆放' : '站位：拖动参考');
  $('placementControls').hidden = !state.editingReference;
  $('zoomBar').hidden = state.editingReference;
  $('placementBadge').hidden = !state.editingReference;
  $('placementHint').textContent = state.editingReference
    ? `轻点或拖动来摆放${state.kind === 'person' ? '人物脚点' : '脸部中心'}；完成后锁定参考。方向键也可以微调。`
    : state.manualTarget ? '参考已摆好。保持机位，让人物靠近火柴人；参考固定在取景画面上。'
    : '点底部“站位”，直接在取景画面轻点或拖动参考。';
  $('plannerAvailability').textContent = state.kind === 'person' ? '选好后保持机位，让人物移动到参考点。' : '当前景别裁掉了下半身；请直接摆放脸部参考，或切到完整人物景别比较背景站位。';
}

function clearPlan(message = '') {
  const hadReference = Boolean(state.planTarget || state.manualTarget);
  state.planTarget = null; state.manualTarget = null; state.referencePosition = null;
  if (hadReference && message) toast(message);
}

function renderPosePanel() {
  const focusedPose = document.activeElement?.dataset.pose;
  const recommended = recommendPoses({scene:state.scene,shot:state.shot,limit:POSES.length});
  if (!recommended.some(p => p.id === state.poseId)) state.poseId = recommended[0]?.id || POSES[0].id;
  const pose = getPose(state.poseId);
  const primary = recommended.slice(0,3);
  if (!primary.some(p => p.id === pose.id) && primary.length) primary[primary.length - 1] = pose;
  const miniatureTarget = targetForShot({shot:state.shot,preset:'center'});
  miniatureTarget.x = .5;
  if (shotConfig().kind === 'person') {miniatureTarget.height=miniatureTarget.bodyHeight=.82;miniatureTarget.y=.92;}
  const transform = getShotTemplateTransform({shot:state.shot,target:miniatureTarget,aspect:.75});
  const card = p => `<button class="pose-card${p.id === state.poseId ? ' selected' : ''}" data-pose="${p.id}" aria-label="${p.name}" aria-pressed="${p.id === state.poseId}" title="${p.shortReason}"><span class="pose-preview"><span style="left:${transform.left*100}%;top:${transform.top*100}%;width:${transform.width*100}%;height:${transform.height*100}%">${renderPoseSvg(p.id)}</span></span><strong>${p.name}</strong></button>`;
  $('poseList').innerHTML = primary.map(card).join('');
  $('poseLibrary').innerHTML = recommended.filter(p => !primary.some(x=>x.id===p.id)).map(card).join('');
  $('poseLibrary').hidden = !state.morePoses;
  $('morePosesBtn').hidden = recommended.length <= 3;
  $('morePosesBtn').setAttribute('aria-expanded',state.morePoses);
  $('morePosesBtn').textContent = state.morePoses ? '收起更多姿势' : `更多适用姿势 · ${Math.max(0,recommended.length-3)}`;
  $('poseName').textContent = pose.name;
  $('poseReason').textContent = pose.shortReason;
  $('poseBody').textContent = pose.cues.body;
  $('poseHands').textContent = pose.cues.hands;
  $('poseGaze').textContent = pose.cues.gaze;
  $('poseProp').hidden = !pose.needsProp;
  $('poseProp').textContent = pose.needsProp ? `需要条件：${pose.needsProp}` : '';
  $('toolbarPose').textContent = pose.name;
  $('bodyTarget').innerHTML = renderPoseSvg(pose.id, {mirror:state.poseFlipped});
  $('mirrorPoseBtn').setAttribute('aria-pressed',state.poseFlipped);
  $('showPoseBtn').setAttribute('aria-pressed',state.poseVisible);
  $('showPoseBtn').textContent = state.poseVisible ? '隐藏火柴人参考' : '显示火柴人参考';
  $$('[data-scene]').forEach(b => {const yes=b.dataset.scene===state.scene;b.classList.toggle('selected',yes);b.setAttribute('aria-pressed',yes);});
  if (focusedPose) document.querySelector(`.pose-card[data-pose="${focusedPose}"]`)?.focus({preventScroll:true});
}

async function changeShot(id) {
  const shot = SHOTS.find(s => s.id === id);
  if (!shot || id === state.shot) return;
  cancelCountdown(); clearPlan(); state.editingReference = false;
  state.shot = id;
  if (shot.kind === 'person') state.bodyHeight = shot.recommendedBodyHeight;
  renderPosePanel();
  if (state.kind !== shot.kind) await changeKind(shot.kind, {detect:state.source !== 'demo',preserveCrop:true});
  syncSettings(); updateSourceUI(); updateGuidance();
}

function placeTarget(x, y, position = null) {
  const target = currentTarget();
  clearPlan();
  state.manualTarget = constrainPoseTarget({shot:state.shot,target:{...target,x:clamp(x,.02,.98),y:clamp(y,.02,.98)},aspect:state.aspect,poseId:state.poseId,mirrored:state.poseFlipped}).target;
  state.referencePosition = position; state.actor = 'person';
  syncSettings(); updateGuidance();
}

function draw(options={}) {
  const stage = $('cameraStage');
  const width = Math.max(1, Math.min(stage.clientWidth, stage.clientHeight * state.aspect));
  const w=`${width}px`,h=`${width/state.aspect}px`;
  if(frame.style.width!==w)frame.style.width=w;
  if(frame.style.height!==h)frame.style.height=h;
  if(frame.style.aspectRatio!==String(state.aspect))frame.style.aspectRatio=String(state.aspect);
  state.crop = currentCrop();
  video.style.transform = `scale(${state.mirrored ? -state.liveDigitalZoom : state.liveDigitalZoom}, ${state.liveDigitalZoom})`;
  if (state.source !== 'camera' && state.image && state.crop) {
    const width = Math.round(Math.max(300, frame.clientWidth) * Math.min(devicePixelRatio || 1, 2));
    const height = Math.round(width / state.aspect);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const c = state.crop;
    ctx.drawImage(state.image, c.sx, c.sy, c.sw, c.sh, 0, 0, width, height);
  }
  if(options.guidance!==false)updateGuidance();
}

function setIcon(id, name, direction) {
  const el = $(id);
  el.querySelector('use').setAttribute('href', '#i-' + name);
  const rotation = { left: 180, right: 0, up: -90, down: 90 };
  el.querySelector('svg').style.transform = direction ? `rotate(${rotation[direction]}deg)` : '';
}

function updateGuidance() {
  state.crop=currentCrop();
  syncSettings();
  const body = state.kind === 'person';
  const target = currentTarget();
  const rawPoint = viewPoint(state.anchor);
  const rawBox = viewBox();
  const fixedReference = Boolean(state.manualTarget || state.planTarget);
  const actor = state.source === 'camera' || fixedReference ? state.actor : 'camera';
  const nowMs = performance.now();
  const observation = state.source === 'camera'
    ? state.observation && camera.running && !state.cameraPending && !controlsPending() && !zoomFrameId
      ? {...state.observation, point:rawPoint, box:rawBox, origin:'detected'} : null
    : state.anchor ? {point:rawPoint,box:rawBox,origin:state.sampleAnchor?'example':state.box?'detected':'manual'} : null;
  const reading = stabilizer.update({shot:state.shot,target,actor,mirrored:state.mirrored,sourceMode:state.source,
    sourceKey:sourceKey(),
    nowMs,observation,expectedIntervalMs:state.observation?.expectedIntervalMs});
  const point = reading.point, box = reading.box;
  let result = reading.guidance;
  state.tracking = reading.tracking;
  state.acceptedReading={point,box,origin:observation?.origin||'none',sourceKey:sourceKey(),expiresAtMs:reading.tracking.expiresAtMs};
  clearTimeout(guidanceExpiryTimer);
  if (state.source === 'camera' && reading.tracking.expiresAtMs != null) {
    guidanceExpiryTimer = setTimeout(updateGuidance, Math.max(16,reading.tracking.expiresAtMs - nowMs + 2));
  }
  if (!point) {
    if (state.detectionPending) result = {...result,title:`正在寻找${body ? '人物' : '脸部'}…`,detail:'画面在本机分析，期间也可以照着火柴人参考拍摄。'};
    else if (state.source !== 'camera') result = {...result,title:'可以先照着姿势参考拍摄',detail:`照片中轻点${body ? '脚下' : '脸部中心'}可标记实际人物；如果正在编辑站位，先点“完成摆放”。`};
    if (state.source === 'camera' && ['unavailable','error'].includes(state.lastCameraStatus?.state)) {
      result.title = camera.running ? '可以参考火柴人继续拍摄' : '请重新开启相机';
      result.detail = state.lastCameraStatus.message;
    }
  }
  if (state.source !== 'camera' && fixedReference && state.anchor && !state.detectionPending) {
    result.detail = `当前是站位预演，照片里的人物不会移动。现场拍摄时保持机位，参考火柴人调整${body ? '站位' : '脸部位置'}。`;
  }
  state.analysis = result;
  $('targetPoint').style.left = `${target.x * 100}%`;
  $('targetPoint').style.top = `${target.y * 100}%`;
  $('targetPoint').classList.toggle('aligned',result.status === 'aligned');
  $('targetPoint').classList.toggle('body-point',body);
  $('targetPoint').hidden = !state.grid && !state.editingReference;
  $('subjectPoint').hidden = !state.grid || !point?.visible;
  if (point?.visible) {
    $('subjectPoint').style.left = `${point.x * 100}%`;
    $('subjectPoint').style.top = `${point.y * 100}%`;
  }
  $('guideLine').style.display = state.grid && point?.visible && result.status !== 'aligned' ? '' : 'none';
  if (point?.visible) {
    $('guideLine').setAttribute('x1',point.x*300);$('guideLine').setAttribute('y1',point.y*400);
    $('guideLine').setAttribute('x2',target.x*300);$('guideLine').setAttribute('y2',target.y*400);
  }
  $('gridLines').querySelector('path').setAttribute('d',gridPath(state.preset));
  $('guides').style.visibility = state.grid ? 'visible' : 'hidden';
  const fb = $('faceBox');
  if (box && point?.visible) {
    fb.removeAttribute('hidden');fb.setAttribute('x',box.x*300);fb.setAttribute('y',box.y*400);
    fb.setAttribute('width',box.width*300);fb.setAttribute('height',box.height*400);
  } else fb.setAttribute('hidden','');
  const ghost = $('bodyTarget');
  ghost.hidden = !state.poseVisible;
  const transform = getShotTemplateTransform({shot:state.shot,target,aspect:state.aspect});
  for (const key of ['left','top','width','height']) ghost.style[key] = `${transform[key]*100}%`;
  ghost.style.opacity = state.poseOpacity;
  const pose = getPose(state.poseId);
  $('poseCaption').textContent = `${shotConfig().name} · ${pose?.name || '姿势参考'}${state.poseFlipped ? ' · 已翻转' : ''}`;
  $('poseCaption').hidden = !state.poseVisible;
  $('guideTitle').textContent = result.title;$('guideDetail').textContent = result.detail;
  $('liveTipText').textContent = state.editingReference ? `摆放${body ? '脚点' : '脸部中心'}参考` : result.title;
  $('liveTip').classList.toggle('aligned',result.status === 'aligned' && !state.editingReference);
  $('matchValue').textContent = result.score == null ? '—' : `${result.score}%`;
  $('matchFill').style.width = `${result.score || 0}%`;
  $('guidanceMode').textContent = state.detectionPending ? '检测中' : !point ? '等待可靠位置' : state.sampleAnchor ? '示例预设脚点' : !state.box ? '手动参考' : state.source === 'camera' ? result.stable ? '连续观测已确认' : result.settling ? '正在确认变化' : '连续跟随当前主体' : '照片检测参考';
  $('dockStatus').textContent = state.source === 'camera' ? result.stable ? '连续对齐 · 参考不会进入照片' : '设备内分析 · 参考不会进入照片' : '示例与照片仅供练习 · 画面不上传';
  $('planActive').hidden = !fixedReference;
  document.querySelector('.actor-setting').hidden = state.source !== 'camera' && !fixedReference;
  $('planActiveText').textContent = state.planTarget ? '背景站位参考 · 请保持机位' : state.manualTarget ? `${body ? '自定义脚点' : '自定义脸部参考'} · 固定在取景画面上` : '';
  const icon = state.editingReference ? 'frame' : result.status === 'aligned' ? 'check' : result.direction ? 'arrow' : 'eye';
  setIcon('tipIcon',icon,state.editingReference ? null : result.direction);setIcon('largeGuideIcon',icon,result.direction);
  updateCoordination();
}

function acceptedObservation() {
  const r=state.acceptedReading;
  if(!r||r.sourceKey!==sourceKey()||controlsPending()||zoomFrameId)return null;
  if(state.source==='camera'&&(!camera.running||state.cameraPending||(r.expiresAtMs!=null&&performance.now()>=r.expiresAtMs)))return null;
  return r;
}
function updateCoordination() {
  const reading=acceptedObservation(),z=zoomConfig();
  const result=assessFrameCoordination({shot:state.shot,target:currentTarget(),aspect:state.aspect,poseId:state.poseId,poseMirrored:state.poseFlipped,
    point:reading?.point,box:reading?.box,observedKind:state.kind,observationOrigin:reading?.origin||'none',
    zoom:{...z,pending:z.pending||controlsPending()},sourceKey:sourceKey(),zoomRevision:state.zoomRevision,background:workbench?.getBackground()});
  state.coordination=result;
  $('coordinationStatus').textContent=result.summary;
  const signature=JSON.stringify(result.checks.map(c=>[c.code,c.state,c.title,c.detail]));
  if(signature!==coordinationSignature){
    coordinationSignature=signature;const fragment=document.createDocumentFragment();
    for(const check of result.checks){
      const row=document.createElement('div');row.className='coordination-check';row.dataset.state=check.state;
      const symbol=document.createElement('span');symbol.textContent=check.state==='pass'?'✓':check.state==='warn'?'!':'·';symbol.setAttribute('aria-hidden','true');
      const copy=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p');title.textContent=check.title;detail.textContent=check.detail;
      copy.append(title,detail);row.append(symbol,copy);fragment.append(row);
    }
    $('coordinationChecks').replaceChildren(fragment);
  }
  const advice=result.zoomAdvice,canApply=advice&&!z.pending&&!controlsPending()&&Math.abs(advice.feasible-z.value)>.05;
  $('applyZoomAdviceBtn').hidden=!canApply;$('zoomAdviceNote').hidden=!canApply;
  if(canApply){$('applyZoomAdviceBtn').textContent=`尝试 ${zoomLabel(advice.feasible)} · 匹配人物占比`;$('zoomAdviceNote').textContent=advice.note;}
  $('planFromGuideBtn').disabled=state.kind!=='person'||state.cameraPending||controlsPending()||Boolean(zoomFrameId)||(state.source==='camera'?!camera.running:!state.image?.naturalWidth);
  const structural=result.warnings.find(c=>['pose_frame','shot_scale','subject_frame'].includes(c.code));
  if(structural&&!state.editingReference&&!zoomFrameId&&!controlsPending()){$('liveTipText').textContent=structural.title;$('liveTip').classList.remove('aligned');setIcon('tipIcon','frame');}
}
function setCaptureMode(mode) {
  if(!['photo','guide','style'].includes(mode))return;
  state.shootMode=mode;cancelCountdown();closeInlineZoom();state.editingReference=false;
  const app=document.querySelector('.camera-app');app.classList.remove('mode-photo','mode-guide','mode-style');app.classList.add(`mode-${mode}`);
  $$('[data-capture-mode]').forEach(button=>{const yes=button.dataset.captureMode===mode;button.classList.toggle('selected',yes);button.setAttribute('aria-pressed',yes);});
  $('styleQuickBar').hidden=mode!=='style';updateSourceUI();draw();
}
function changeAspect(value) {
  stopZoomMotion();cancelCountdown();clearPlan('画幅已改变，请按新画面确认站位。');state.editingReference=false;state.aspect=value;
  ++state.zoomRevision;stabilizer.reset();workbench?.invalidate();
  $$('[data-aspect]').forEach(button=>{const yes=Math.abs(Number(button.dataset.aspect)-value)<.001;button.classList.toggle('selected',yes);button.setAttribute('aria-pressed',yes);});
  const label=value===1?'1:1':value<1?'3:4':'4:3';$('aspectLabel').textContent=label;$('aspectBtn').setAttribute('aria-label',`切换画幅比例，当前${label}`);
  syncSettings();syncZoomUI();draw();
}

function updateSourceUI() {
  const live = state.source === 'camera';
  const imageReady = Boolean(state.image?.naturalWidth && state.image?.naturalHeight);
  frame.style.touchAction = 'none';
  video.hidden = !live; canvas.hidden = live;
  video.classList.toggle('mirrored', state.mirrored);
  $('practiceTools').hidden = live;
  $('photoAdjust').hidden = live;
  $('zoomTools').hidden = live;
  $('portraitBtn').hidden = state.portrait;
  $('detectAgainBtn').hidden = live;
  $('detectAgainBtn').textContent = state.kind === 'person' ? '自动检测人物' : '自动检测脸部';
  $('detectAgainBtn').disabled = state.detectionPending;
  $('planBtn').disabled = state.kind !== 'person' || state.cameraPending || controlsPending() || Boolean(zoomFrameId) || (live ? !camera.running : !imageReady);
  $('switchBtn').disabled = !live || !camera.running || state.cameraPending;
  $('shutterBtn').disabled = state.busy || (live ? !camera.running : !imageReady);
  $('cameraBtn').disabled = state.cameraPending;
  $('quickCameraBtn').hidden = state.editingReference || (live && camera.running);
  $('quickCameraBtn').disabled = state.cameraPending;
  $('quickCameraBtn').querySelector('span').textContent = state.cameraPending ? '正在开启…' : state.lastCameraStatus?.state === 'error' ? '重新开启相机' : '开启相机';
  $('cameraBtn').querySelector('span').textContent = state.cameraPending ? '正在开启相机…' : live && camera.running ? '关闭相机，继续练习' : live ? '重新开启相机' : '开启我的相机';
  $('demoBtn').hidden = state.source === 'demo' && !state.cameraPending;
  $('sourceTag').textContent = live ? '实时相机' : state.portrait ? '人像示例' : state.source === 'photo' ? '照片复盘' : '示例练习';
  $('modeBadge').lastChild.textContent = live ? `实时 · ${state.kind === 'person' ? '人体' : '人脸'}辅助` : state.portrait ? '人像示例' : state.source === 'photo' ? '本地照片' : state.sampleAnchor ? '示例 · 预设脚点' : '示例练习';
  $('shutterLabel').textContent = live ? '拍一张' : state.source === 'photo' ? '生成裁剪图' : '试拍一张';
  $('viewHint').textContent = state.editingReference ? '仅移动参考，不改变照片或实际人物点' : live ? '白点：实际位置 · 浅绿：目标参考' : `照片练习 · 点选${state.kind === 'person' ? '实际脚点' : '脸部中心'}，拖动调整画面`;
  frame.setAttribute('aria-label', live ? `实时取景画面，根据${state.kind === 'person' ? '人体' : '人脸'}位置给出构图提示` : '取景画面，可拖动调整构图；方向键微调照片');
  $('zoomSlider').value = state.zoom; $('zoomValue').textContent = `${state.zoom.toFixed(1)}×`;
  if (state.source === 'demo') $('photoCredit').textContent = 'AI 生成演示图 · ' + (state.sampleAnchor ? '白点为预设脚点，可点选自动检测' : '可轻点标记实际人物位置');
  else if (state.portrait) $('photoCredit').textContent = 'AI 生成演示人像 · 人脸位置由本机识别';
  else $('photoCredit').textContent = live ? '相机画面仅用于设备内识别；照片分辨率以实际视频帧为准。' : '照片在本机处理。生成的是新裁剪图，原文件保持不变。';
  syncSettings();
  syncZoomUI();
}

function cancelCountdown() {
  if (state.countdownId) clearInterval(state.countdownId);
  state.countdownId = 0;
  $('countdown').hidden = true;
  if (!state.encoding) state.busy = false;
  $('shutterBtn').disabled = state.encoding || (state.source === 'camera' ? !camera.running||controlsPending() : !state.image?.naturalWidth);
  $('shutterBtn').setAttribute('aria-label', '拍摄当前画面');
}

function resetStaticCrop() {
  stopZoomMotion();workbench?.invalidate();
  const { w, h } = size();
  if (!w || !h) { updateSourceUI(); draw(); return; }
  if (state.source === 'demo') {
    state.zoom = state.kind === 'person' ? 1 : 2;
    const base = getCoverCrop(w, h, state.aspect, 1);
    const cw = base.sw / state.zoom;
    state.panX = state.kind === 'person' ? .5 : (.517 * w + cw * .05) / w;
    state.panY = state.kind === 'person' ? .5 : .622;
  } else {
    state.zoom = 1.15;
    state.panX = .5; state.panY = .5;
  }
  updateSourceUI(); draw();
}

function useDemo() {
  stopZoomMotion();closeInlineZoom();workbench?.invalidate();
  ++state.operation; ++importGeneration; ++state.manualRevision;
  state.cameraPending = false;
  camera.stop(); cancelCountdown();
  if (state.inputURL) { URL.revokeObjectURL(state.inputURL); state.inputURL = null; }
  state.source = 'demo'; state.portrait = false; state.image = demoImage;
  clearPlan();
  state.anchor = state.kind === 'person' ? {x:.622,y:.86} : null; state.sampleAnchor = state.kind === 'person'; state.editingReference = false; state.box = null; state.faceCount = 0; state.personCount = 0;
  state.mirrored = false; state.detectionPending = false; state.lastCameraStatus = null;
  $('viewNotice').hidden = true; statusMessage('', false);
  resetStaticCrop();
  updateGuidance();
}

async function activateCamera() {
  stopZoomMotion();closeInlineZoom();workbench?.invalidate();
  if (state.cameraPending) return;
  if (state.source === 'camera' && camera.running) { useDemo(); return; }
  cancelCountdown();
  const operation = ++state.operation;
  ++importGeneration; ++state.manualRevision;
  state.cameraPending = true;
  state.liveDigitalZoom=1;++state.zoomRevision;
  updateSourceUI();
  const success = await camera.start();
  if (state.operation !== operation) return;
  state.cameraPending = false;
  if (success) {
    clearPlan();
    state.source = 'camera'; state.observation = null; state.anchor = null; state.box = null; state.sampleAnchor = false; state.editingReference = false;
    state.mirrored = camera.mirrored; state.portrait = false;
    $('viewNotice').hidden = true;
  }
  updateSourceUI(); draw();
  if (!success && state.lastCameraStatus?.message) { $('viewNotice').textContent=state.lastCameraStatus.message; $('viewNotice').hidden=false; }
}

async function changeCamera() {
  stopZoomMotion();closeInlineZoom();workbench?.invalidate();
  if (state.cameraPending || state.source !== 'camera') return;
  cancelCountdown();
  clearPlan('切换镜头后，请按新的背景重新规划站位。');
  const operation = ++state.operation;
  state.liveDigitalZoom=1;++state.zoomRevision;
  state.cameraPending = true; state.observation = null; state.anchor = null; state.box = null;
  $('shutterBtn').disabled = true; updateSourceUI();
  const previousFacing = camera.facing;
  const success = await camera.switchCamera();
  if (operation !== state.operation) return;
  state.cameraPending = false; state.mirrored = camera.mirrored;
  if (success) { $('viewNotice').hidden = true; if (camera.facing === previousFacing) toast('当前设备可能只有一个可用摄像头。'); }
  updateSourceUI(); draw();
}

async function loadImage(source) {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  return image;
}

async function detectStatic() {
  if (state.source === 'camera' || !state.image?.naturalWidth) return;
  const operation = state.operation, revision = ++state.manualRevision, kind = state.kind;
  const image = state.image;
  state.sampleAnchor = false;
  state.anchor = null; state.box = null; state.faceCount = 0; state.personCount = 0;
  state.detectionPending = true; state.lastCameraStatus = null;
  statusMessage(kind === 'person' ? nativeHost?'正在读取内置人体模型；无需联网。你也可以轻点人物脚下手动标记。':'正在准备本机人体检测；模型未缓存时需要下载。你也可以轻点人物脚下手动标记。' : '正在准备本机人脸检测；你也可以直接轻点照片标记主体。');
  updateSourceUI(); updateGuidance();
  let result;
  try { result = await camera.detectImage(image, { mode: kind }); }
  catch { result = { error: '检测暂不可用；可以轻点画面手动标记。' }; }
  if (operation !== state.operation || revision !== state.manualRevision || kind !== state.kind) return;
  state.detectionPending = false;
  if (result.point) {
    state.anchor = result.point; state.box = result.box;
    state.faceCount = result.faceCount || 0; state.personCount = result.personCount || 0;
    const count = kind === 'person' ? state.personCount : state.faceCount;
    statusMessage(kind === 'person' ? `${count > 1 ? '检测到多个人，当前参考最大的人物。' : '已检测到人物。'}白点取人体框底部中点，作为脚点近似；轻点可改为手动参考。` : count > 1 ? '检测到多张人脸，当前参考最大的人脸。轻点照片可换成手动主体。' : '已检测到人脸。拖动画面调整，也可以轻点其他位置重新选择主体。');
  } else statusMessage(result.error || (kind === 'person' ? '未检测到人物。人物过小或遮挡时可能漏检；轻点人物脚下可手动标记。' : '没有检测到近处人脸。轻点你想强调的主体，照样可以练习构图。'));
  updateSourceUI(); updateGuidance();
}

async function changeKind(kind, {detect=true,preserveCrop=false} = {}) {
  if (!['face','person'].includes(kind)) return;
  cancelCountdown();clearPlan();++state.manualRevision;
  state.kind = kind;state.observation = null;state.anchor = null;state.box = null;state.faceCount = 0;state.personCount = 0;state.sampleAnchor = false;
  state.lastCameraStatus = null;state.detectionPending = state.source === 'camera';
  const modeReady = camera.setDetectionMode(kind);
  if (state.source === 'demo' && kind === 'person' && !detect) {
    state.anchor = {x:.5177,y:.7352};state.sampleAnchor = true;
  }
  if (state.source !== 'camera') {
    state.detectionPending = false;
    statusMessage('',false);
    if (!preserveCrop) resetStaticCrop();
    if (detect) detectStatic();
  }
  syncSettings();updateSourceUI();updateGuidance();
  await modeReady;
}

async function setPhoto(image, { portrait = false, inputURL = null } = {}) {
  stopZoomMotion();closeInlineZoom();workbench?.invalidate();
  ++state.operation; ++state.manualRevision;
  state.cameraPending = false;
  camera.stop(); cancelCountdown(); clearPlan();
  if (portrait && state.kind !== 'face') {state.shot='close';state.kind='face';camera.setDetectionMode('face');renderPosePanel();}
  state.sampleAnchor=false;state.editingReference=false;
  if (state.inputURL && state.inputURL !== inputURL) URL.revokeObjectURL(state.inputURL);
  state.inputURL = inputURL;
  state.source = 'photo'; state.image = image; state.anchor = null; state.box = null;
  state.portrait = portrait; state.mirrored = false; state.faceCount = 0; state.personCount = 0;
  state.detectionPending = true; state.lastCameraStatus = null;
  $('viewNotice').hidden = true;
  resetStaticCrop();
  await detectStatic();
}

function nudge(direction) {
  if (state.source === 'camera' || !state.crop || !state.image || state.busy) return;
  clearPlan('取景范围已改变，请重新规划背景站位。');
  const { w, h } = size();
  const step = .035;
  if (direction === 'left') state.panX += state.crop.sw / w * step;
  if (direction === 'right') state.panX -= state.crop.sw / w * step;
  if (direction === 'up') state.panY += state.crop.sh / h * step;
  if (direction === 'down') state.panY -= state.crop.sh / h * step;
  draw();
}

function openDialog(dialog, trigger) {
  if (dialog.open) return;
  closeInlineZoom();
  cancelCountdown();
  pressStarted=false; drag=null;
  activePointers.clear();pinch=null;pinching=false;
  dialogOrigins.set(dialog,trigger || document.activeElement);
  dialogStack.push(dialog);
  dialog.showModal();
}

function finishPlacement() {
  state.editingReference=false;
  updateSourceUI(); updateGuidance();
  $('placeReferenceBtn').focus({preventScroll:true});
}


async function capture() {
  if (state.busy || state.cameraPending || controlsPending() || state.nativeSaving) return;
  if (state.source === 'camera' && (!camera.running || video.readyState < 2)) { toast('相机画面还没有准备好，请稍后重试。'); return; }
  stopZoomMotion();syncZoomUI();draw();
  const crop = currentCrop();
  const media = state.source === 'camera' ? video : state.image;
  if (!crop || !media) return;
  state.busy = true; state.encoding = true; $('shutterBtn').disabled = true;
  const output = document.createElement('canvas');
  const scale = Math.min(1, 2400 / Math.max(crop.sw, crop.sh));
  output.width = Math.max(1, Math.round(crop.sw * scale));
  output.height = Math.max(1, Math.round(crop.sh * scale));
  const out = output.getContext('2d');
  const style=workbench?.getStyleSnapshot();
  const useCanvasFilter=style&&!isStyleIdentity(style.settings)&&'filter' in out;
  if(useCanvasFilter)out.filter=style.filter;
  if (state.mirrored) { out.translate(output.width, 0); out.scale(-1, 1); }
  out.drawImage(media, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, output.width, output.height);
  if(style&&!isStyleIdentity(style.settings)&&!useCanvasFilter){const pixels=out.getImageData(0,0,output.width,output.height);applyStylePixels(pixels.data,style.settings,{inPlace:true});out.putImageData(pixels,0,0);}
  const captureSource = state.source;
  const capturePreset = `${shotConfig().name} · ${PRESETS.find(p=>p.id===state.preset).name}`;
  const match = state.analysis?.score;
  const operation = state.operation;
  try {
    const blob = await new Promise((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('图像编码失败')), 'image/jpeg', .94));
    if (operation !== state.operation) return;
    if (state.photoURL) URL.revokeObjectURL(state.photoURL);
    state.photoURL = URL.createObjectURL(blob);
    state.photoBlob = blob;
    state.downloadName = `取景-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
    $('capturedImage').src = state.photoURL;
    $('captureTitle').textContent = captureSource === 'demo' ? '把这一刻，留在画面里。' : '这一张，由你决定。';
    $('captureMeta').textContent = `${capturePreset} · ${style?.name||'原色'} · ${output.width} × ${output.height}`;
    $('captureMatch').textContent = match === null || match === undefined ? '未评估主体位置' : `位置匹配 ${match}%`;
    const shareFile = new File([blob],state.downloadName,{type:'image/jpeg'});
    $('sharePhotoBtn').hidden = Boolean(nativeHost) || !(navigator.share && navigator.canShare?.({files:[shareFile]}));
    $('saveNote').textContent = '照片尚未保存；关闭预览不会自动存入相册。';
    $('captureFlash').classList.remove('flash');
    void $('captureFlash').offsetWidth;
    $('captureFlash').classList.add('flash');
    openDialog($('photoDialog'), $('shutterBtn'));
  } catch {
    toast('暂时无法生成照片，请重新拍摄或换一张图片重试。');
  } finally {
    state.encoding = false; state.busy = false; updateSourceUI();
  }
}

function shutter() {
  if (state.countdownId) { cancelCountdown(); toast('已取消定时拍摄'); return; }
  if (state.busy || state.cameraPending || controlsPending()) return;
  stopZoomMotion();syncZoomUI();
  if (!state.timer) { capture(); return; }
  let remaining = 3;
  const operation = state.operation;
  state.busy = true;
  $('countdown').hidden = false; $('countdown').textContent = remaining;
  $('shutterBtn').setAttribute('aria-label', '取消定时拍摄');
  state.countdownId = setInterval(() => {
    if (state.operation !== operation) { cancelCountdown(); return; }
    remaining--;
    if (remaining <= 0) { cancelCountdown(); capture(); }
    else $('countdown').textContent = remaining;
  }, 1000);
}

function openPlanner() {
  if (state.kind !== 'person') {toast('这个景别请直接摆放脸部参考；背景站位适用于完整人物。');return;}
  if (controlsPending()) {toast('等相机参数调节完成后，再比较当前背景站位。');return;}
  stopZoomMotion();syncZoomUI();draw();
  if (state.cameraPending) { toast('等相机开启完成后，再用当前背景规划。'); return; }
  const crop = currentCrop();
  const media = state.source === 'camera' ? video : state.image;
  if (!crop || !media || (state.source === 'camera' && (!camera.running || video.readyState < 2))) { toast('等画面准备好后再规划站位。'); return; }
  cancelCountdown();
  const surface = $('plannerCanvas');
  const scale = Math.min(1, 640 / Math.max(crop.sw, crop.sh));
  surface.width = Math.max(1, Math.round(crop.sw * scale));
  surface.height = Math.max(1, Math.round(crop.sh * scale));
  const context = surface.getContext('2d', { willReadFrequently: true });
  context.save();
  if (state.mirrored) { context.translate(surface.width, 0); context.scale(-1, 1); }
  context.drawImage(media, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, surface.width, surface.height);
  context.restore();
  try { planner.pixels = context.getImageData(0, 0, surface.width, surface.height); }
  catch { toast('无法读取这个背景，请重新导入照片或重开相机。'); return; }
  planner.region = null; planner.candidates = []; planner.selected = -1;
  planner.operation = state.operation; planner.aspect = state.aspect; planner.height = state.bodyHeight; planner.shot = state.shot;
  planner.zoomRevision = state.zoomRevision;planner.sourceKey=sourceKey();planner.poseId=state.poseId;planner.poseMirrored=state.poseFlipped;
  const observation=acceptedObservation();
  planner.subjectBox=observation?.origin==='detected'&&observation.point?.visible&&observation.box?{...observation.box}:null;
  planner.source = state.source; planner.sourceImage = state.image; planner.crop = JSON.stringify(crop); planner.mirrored = state.mirrored;
  $('plannerStage').style.aspectRatio = String(state.aspect);
  $('plannerStatus').textContent = '先框出一块现场实际可站立的地面，画面不会替你判断可达性。';
  renderPlanner();
  openDialog($('plannerDialog'), $('planBtn'));
}

function renderPlanner() {
  const region = planner.region;
  $('groundRegion').toggleAttribute('hidden', !region);
  if (region) for (const [key, value] of Object.entries({x:region.x,y:region.y,width:region.w,height:region.h})) $('groundRegion').setAttribute(key, value * 100);
  $('findCandidatesBtn').disabled = !region || region.w < .025 || region.h < .025;
  $('useCandidateBtn').disabled = planner.selected < 0 || !planner.candidates[planner.selected];
  const pins = $('candidatePins'), list = $('candidateList');
  pins.replaceChildren(); list.replaceChildren();
  planner.candidates.forEach((candidate, index) => {
    const selected = index === planner.selected;
    const outline = document.createElement('div'); outline.className = 'planner-silhouette' + (selected ? ' selected' : '');
    for(const key of ['left','top','width','height'])outline.style[key]=`${candidate.template[key]*100}%`;
    const silhouette = $('bodyTarget').querySelector('svg').cloneNode(true);
    silhouette.style.cssText = 'width:100%;height:100%;stroke:#effdc5;fill:#d9ed9b20;stroke-width:1'; outline.append(silhouette); pins.append(outline);
    const pin = document.createElement('button'); pin.className = 'candidate-pin' + (selected ? ' selected' : '');
    pin.textContent = String(index+1); pin.setAttribute('aria-label', `选择站位${index+1}`); pin.setAttribute('aria-pressed', selected);
    pin.style.left = `${candidate.x*100}%`; pin.style.top = `${candidate.y*100}%`;
    pin.addEventListener('click', () => selectCandidate(index)); pins.append(pin);
    const option = document.createElement('button'); option.className = 'candidate-option' + (selected ? ' selected' : '');
    option.setAttribute('aria-pressed', selected);
    const number = document.createElement('span'); number.textContent = String(index+1);
    const copy = document.createElement('span'), title = document.createElement('strong'), reason = document.createElement('small');
    title.textContent = `站位 ${index+1}${index === 0 ? ' · 优先参考' : ''}`; reason.textContent = candidate.reason;
    copy.append(title,reason); option.append(number,copy); option.addEventListener('click', () => selectCandidate(index)); list.append(option);
  });
}

function selectCandidate(index) { planner.selected = index; renderPlanner(); }

function setGroundRegion(region) {
  const x = clamp(region.x,0,.98), y = clamp(region.y,0,.98);
  planner.region = { x, y, w: clamp(region.w,0,1-x), h: clamp(region.h,0,1-y) };
  planner.candidates = []; planner.selected = -1;
  $('plannerStatus').textContent = planner.region.w < .025 || planner.region.h < .025 ? '区域太小，请拖出稍大一点的地面范围。' : '区域已选好。点击“生成站位参考”，比较背景与构图。';
  renderPlanner();
}

function findCandidates() {
  if (!planner.pixels || !planner.region) return;
  const result = planStandingPositions({pixels:planner.pixels.data,width:planner.pixels.width,height:planner.pixels.height,region:planner.region,target:currentTarget(),bodyHeight:planner.height,aspect:planner.aspect,limit:3,poseId:planner.poseId,poseMirrored:planner.poseMirrored,sourceKey:planner.sourceKey,zoomRevision:planner.zoomRevision,zoomPending:controlsPending()||Boolean(zoomFrameId),subjectBox:planner.subjectBox});
  planner.candidates = result.candidates; planner.selected = result.candidates.length ? 0 : -1;
  $('plannerStatus').textContent = result.candidates.length ? `找到 ${result.candidates.length} 个画面参考点。点击编号比较，确认后使用。` : result.diagnostics.message || '这片区域容不下当前人物轮廓。请扩大地面区域，或返回后减小人物占比。';
  renderPlanner();
}

function useCandidate() {
  const candidate = planner.candidates[planner.selected];
  if (!candidate || state.cameraPending || controlsPending() || Boolean(zoomFrameId) || planner.poseId!==state.poseId || planner.poseMirrored!==state.poseFlipped || planner.zoomRevision !== state.zoomRevision || planner.operation !== state.operation || planner.source !== state.source || planner.sourceImage !== state.image || planner.crop !== JSON.stringify(currentCrop()) || planner.mirrored !== state.mirrored || planner.shot !== state.shot) { toast('画面已变化，请重新规划。'); $('plannerDialog').close(); return; }
  clearPlan();state.editingReference=false;
  state.bodyHeight = candidate.height;
  state.planTarget = {x:candidate.x,y:candidate.y,height:candidate.height,label:'背景站位参考'};
  state.actor = 'person';
  $$('[data-actor]').forEach(b => {const yes=b.dataset.actor===state.actor;b.classList.toggle('selected',yes);b.setAttribute('aria-pressed',yes);});
  updateSourceUI(); updateGuidance();
  $('plannerDialog').close();
  $('settingsDialog').close();$('guideDialog').close();
  toast(state.source === 'camera' ? '站位参考已启用。保持当前机位，让人物靠近目标脚点。' : '已显示站位预演。现场拍摄时，请用相机背景重新规划。');
  if (state.source !== 'camera' && !state.box) detectStatic();
}

let regionDrag = null;
$('plannerStage').addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return;
  const r = $('plannerStage').getBoundingClientRect();
  regionDrag = {x:clamp((event.clientX-r.left)/r.width,0,1),y:clamp((event.clientY-r.top)/r.height,0,1)};
  $('plannerStage').setPointerCapture(event.pointerId);
});
$('plannerStage').addEventListener('pointermove', event => {
  if (!regionDrag) return;
  const r = $('plannerStage').getBoundingClientRect();
  const x=clamp((event.clientX-r.left)/r.width,0,1), y=clamp((event.clientY-r.top)/r.height,0,1);
  setGroundRegion({x:Math.min(regionDrag.x,x),y:Math.min(regionDrag.y,y),w:Math.abs(x-regionDrag.x),h:Math.abs(y-regionDrag.y)});
});
$('plannerStage').addEventListener('pointerup', () => { regionDrag = null; });
$('plannerStage').addEventListener('pointercancel', () => { regionDrag = null; });
$('planBtn').addEventListener('click', openPlanner);
$('findCandidatesBtn').addEventListener('click', findCandidates);
$('useCandidateBtn').addEventListener('click', useCandidate);
$('applyRegionBtn').addEventListener('click', () => setGroundRegion({x:Number($('regionX').value)/100,y:Number($('regionY').value)/100,w:Number($('regionW').value)/100,h:Number($('regionH').value)/100}));
$('clearPlanBtn').addEventListener('click', () => {clearPlan();syncSettings();updateGuidance();});
$('plannerDialog').addEventListener('close', () => {regionDrag=null;planner.pixels=null;});

document.querySelector('.preset-list').innerHTML = PRESETS.filter(p=>p.id!=='wide').map(p => {
  const t = targetFor(p.id, 'right');
  return `<button class="preset${p.id === state.preset ? ' selected' : ''}" data-preset="${p.id}" aria-pressed="${p.id === state.preset}" title="${p.subtitle}"><span class="preset-thumbnail"><svg viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true"><path d="${gridPath(p.id, 'right')}" vector-effect="non-scaling-stroke"/><circle cx="${t.x*300}" cy="${t.y*400}" r="21"/></svg></span><span><strong>${p.name}</strong><small>${p.subtitle}</small></span></button>`;
}).join('');

$$('[data-aspect]').forEach(btn=>btn.addEventListener('click',()=>changeAspect(Number(btn.dataset.aspect))));
$$('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
  clearPlan(); state.preset = btn.dataset.preset;
  $$('[data-preset]').forEach(b => { const yes = b === btn; b.classList.toggle('selected', yes); b.setAttribute('aria-pressed', yes); });
  syncSettings(); updateGuidance();
}));
$$('[data-kind]').forEach(btn => btn.addEventListener('click', () => {if (btn.dataset.kind !== state.kind) changeKind(btn.dataset.kind);}));
$$('[data-actor]').forEach(btn => btn.addEventListener('click', () => {
  state.actor = btn.dataset.actor;
  if (state.actor === 'camera') clearPlan('移动手机会改变背景参考，已恢复构图模板。');
  $$('[data-actor]').forEach(b => {const yes=b===btn;b.classList.toggle('selected',yes);b.setAttribute('aria-pressed',yes);});
  updateGuidance();
}));
function setBodyHeight(value) {
  clearPlan('人物占比已改变，可重新规划背景站位。');
  state.bodyHeight = clamp(value,.06,.88); syncSettings(); updateGuidance();
}
$('bodyHeight').addEventListener('input', event => setBodyHeight(Number(event.target.value)/100));
$$('[data-body-height]').forEach(btn => btn.addEventListener('click', () => setBodyHeight(Number(btn.dataset.bodyHeight))));
$('detectAgainBtn').addEventListener('click', () => {$('settingsDialog').close();detectStatic();});
$$('[data-side]').forEach(btn => btn.addEventListener('click', () => {
  clearPlan(); state.side = btn.dataset.side;
  $$('[data-side]').forEach(b => { const yes = b === btn; b.classList.toggle('selected', yes); b.setAttribute('aria-pressed', yes); });
  syncSettings();updateGuidance();
}));
$$('[data-nudge]').forEach(btn => btn.addEventListener('click', () => nudge(btn.dataset.nudge)));
$('resetBtn').addEventListener('click', () => { cancelCountdown(); clearPlan(); resetStaticCrop(); toast('已回到最初取景'); });
$('zoomSlider').addEventListener('input', event => {
  setMagnification(Number(event.target.value));
});
$('zoomPresets').addEventListener('click',event=>{const button=event.target.closest('[data-magnification]');if(button)setMagnification(Number(button.dataset.magnification));});
$('magnificationSlider').addEventListener('input',event=>setMagnification(zoomFromSlider(Number(event.target.value),zoomConfig())));
$('openZoomBtn').addEventListener('click',()=>{const open=$('zoomInline').hidden;$('zoomInline').hidden=!open;$('openZoomBtn').setAttribute('aria-expanded',open);frame.classList.toggle('zoom-expanded',open);if(open)$('magnificationSlider').focus({preventScroll:true});});
$('closeZoomBtn').addEventListener('click',()=>{closeInlineZoom();$('openZoomBtn').focus({preventScroll:true});});
$('zoomInline').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeInlineZoom();$('openZoomBtn').focus({preventScroll:true});}});
$$('[data-capture-mode]').forEach(button=>button.addEventListener('click',()=>setCaptureMode(button.dataset.captureMode)));
$('aspectBtn').addEventListener('click',()=>{const values=[.75,1,4/3],index=values.findIndex(value=>Math.abs(value-state.aspect)<.001);changeAspect(values[(index+1)%values.length]);});
$('planFromGuideBtn').addEventListener('click',openPlanner);
$('applyZoomAdviceBtn').addEventListener('click',()=>{updateCoordination();const advice=state.coordination?.zoomAdvice;if(advice)setMagnification(advice.feasible);});
$('gridBtn').addEventListener('click', () => {
  state.grid = !state.grid;
  $('gridBtn').setAttribute('aria-pressed', state.grid);
  $('gridBtn').setAttribute('aria-label', `${state.grid ? '隐藏' : '显示'}构图网格`);
  updateGuidance();
});
$('cameraBtn').addEventListener('click', () => {$('settingsDialog').close();activateCamera();});
$('quickCameraBtn').addEventListener('click',activateCamera);
$('demoBtn').addEventListener('click', () => {$('settingsDialog').close();useDemo();});
$('switchBtn').addEventListener('click', changeCamera);
$('shutterBtn').addEventListener('click', shutter);
$('timerBtn').addEventListener('click', () => {
  state.timer = !state.timer; cancelCountdown();
  $('timerLabel').textContent = state.timer ? '3 秒' : '关闭';
  $('timerBtn').setAttribute('aria-pressed', state.timer);
  $('timerBtn').setAttribute('aria-label', state.timer ? '关闭定时拍摄' : '开启3秒定时拍摄');
  toast(state.timer ? '已开启 3 秒定时；再次按快门可取消倒数。' : '已关闭定时拍摄');
});
$('importBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { toast('请选择 JPG、PNG 或 WebP 图片。'); return; }
  if (file.size > 30 * 1024 * 1024) { toast('这张照片超过 30 MB，请先缩小后再导入。'); return; }
  const request = ++importGeneration;
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (request !== importGeneration) { URL.revokeObjectURL(url); return; }
    if (image.naturalWidth * image.naturalHeight > 50000000) { URL.revokeObjectURL(url); toast('这张图片尺寸过大，请缩小到 5000 万像素以内。'); return; }
    await setPhoto(image, { inputURL: url });
  } catch { URL.revokeObjectURL(url); toast('无法读取这张图片，请换成 JPG、PNG 或 WebP 重试。'); }
});
$('portraitBtn').addEventListener('click', async () => {
  $('settingsDialog').close();
  const request = ++importGeneration;
  $('portraitBtn').disabled = true;
  try {
    const image = await loadImage('./assets/portrait.jpg');
    if (request === importGeneration) await setPhoto(image, { portrait: true });
  } catch { toast('人像示例未能加载，你可以导入自己的照片。'); }
  finally { $('portraitBtn').disabled = false; }
});
$('downloadBtn').addEventListener('click', async () => {
  if (!state.photoURL) return;
  if (nativeSaver) {
    if(state.nativeSaving||!state.photoBlob)return;
    state.nativeSaving=true;$('downloadBtn').disabled=true;
    $('saveNote').textContent='请选择保存位置，照片会在你确认后写入。';
    try {
      const result=await nativeSaver.save(state.photoBlob);
      $('saveNote').textContent=result.message || (result.status==='saved'?'照片已保存到你选择的位置。':result.status==='cancelled'?'已取消保存，照片仍保留在预览中。':'未能保存，照片仍保留在预览中，可以重试。');
    } catch { $('saveNote').textContent='未能保存，照片仍保留在预览中，可以重试。'; }
    finally {state.nativeSaving=false;$('downloadBtn').disabled=false;}
    return;
  }
  const link = document.createElement('a');
  link.href = state.photoURL; link.download = state.downloadName;
  document.body.appendChild(link); link.click(); link.remove();
  $('saveNote').textContent = '已发起下载，请查看浏览器下载记录；手机也可长按图片保存。';
});
for (const [trigger,dialog] of [['helpBtn','helpDialog'],['scoreHelp','helpDialog'],['aboutBtn','aboutDialog'],['modelBtn','modelDialog'],['licenseBtn','licenseDialog'],['settingsBtn','settingsDialog'],['liveTip','guideDialog'],['openShotBtn','shotDialog'],['openPoseBtn','poseDialog'],['openCompositionBtn','compositionDialog']]) $(trigger).addEventListener('click', () => openDialog($(dialog),$(trigger)));
const licensePaths = new Set([
  'assets/vendor/LICENSE', 'assets/vendor/NOTICE.txt',
  'assets/vendor/face-api/LICENSE', 'assets/vendor/face-api/TENSORFLOW-LICENSE',
  'assets/vendor/person/LICENSE', 'assets/vendor/person/NOTICE.txt'
]);
$$('[data-license-file]').forEach(button => button.addEventListener('click', async () => {
  const path = button.dataset.licenseFile;
  if (!licensePaths.has(path)) return;
  const display = $('licenseText');
  display.textContent = '正在读取本地许可文件…';
  $$('[data-license-file]').forEach(item => { item.disabled = true; });
  try {
    const response = await fetch('./' + path);
    if (!response.ok) throw new Error('Cannot read local license: ' + response.status);
    display.textContent = await response.text();
  } catch {
    display.textContent = '无法读取本地许可文件。请检查 APK / 离线资源是否完整。';
  } finally {
    $$('[data-license-file]').forEach(item => { item.disabled = false; });
  }
}));
$('finishPlacementBtn').addEventListener('click',finishPlacement);
$('sharePhotoBtn').addEventListener('click',async () => {
  if (!state.photoBlob || state.sharing) return;
  const file=new File([state.photoBlob],state.downloadName,{type:'image/jpeg'});
  if (!navigator.share || !navigator.canShare?.({files:[file]})) {toast('当前设备不支持直接分享文件，可以下载照片。');return;}
  state.sharing=true;$('sharePhotoBtn').disabled=true;
  try {await navigator.share({files:[file],title:'取景照片'});$('saveNote').textContent='系统分享操作已结束，保存结果以你选择的应用为准。';}
  catch (error) {if(error?.name!=='AbortError')$('saveNote').textContent='分享未完成，照片仍保留在预览中，可以重试或下载。';}
  finally {state.sharing=false;$('sharePhotoBtn').disabled=false;}
});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('installBtn').hidden=false;});
window.addEventListener('appinstalled',()=>{installPrompt=null;$('installBtn').hidden=true;});
$('installBtn').addEventListener('click',async()=>{
  if (!installPrompt) {openDialog($('aboutDialog'),$('installBtn'));return;}
  const prompt=installPrompt;installPrompt=null;$('installBtn').hidden=true;
  try {await prompt.prompt();await prompt.userChoice;} catch {openDialog($('aboutDialog'),$('installBtn'));}
});
$$('[data-close]').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog').close()));
$$('dialog').forEach(dialog => {
  dialog.addEventListener('close', () => {
    pressStarted=false;drag=null;
    activePointers.clear();pinch=null;pinching=false;
    const stackIndex=dialogStack.indexOf(dialog);if(stackIndex>=0)dialogStack.splice(stackIndex,1);
    const origin=dialogOrigins.get(dialog);
    if(origin?.isConnected&&!origin.disabled&&(!origin.closest('dialog')||origin.closest('dialog').open)) origin.focus({preventScroll:true});
    else if(!document.querySelector('dialog[open]')) frame.focus({preventScroll:true});
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
});

frame.addEventListener('pointerdown', event => {
  if (event.target.closest('button,input,.zoom-deck,.frame-intelligence') || state.busy) return;
  activePointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(activePointers.size===2&&!state.editingReference) {
    const points=[...activePointers.values()];
    pinch={distance:Math.max(1,Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y)),zoom:zoomConfig().value};
    pinching=true;pressStarted=false;drag=null;frame.setPointerCapture(event.pointerId);return;
  }
  if(activePointers.size>1||pinching)return;
  const r = frame.getBoundingClientRect();
  if (state.editingReference) {
    drag = {mode:'reference',pointerId:event.pointerId};pressStarted=true;frame.setPointerCapture(event.pointerId);
    placeTarget((event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height);
    return;
  }
  if (state.source === 'camera' || !state.crop) {frame.setPointerCapture(event.pointerId);return;}
  drag = {mode:'photo',pointerId:event.pointerId,x:event.clientX,y:event.clientY,panX:state.panX,panY:state.panY,crop:{...state.crop},width:r.width,height:r.height,moved:false};
  pressStarted=true;frame.setPointerCapture(event.pointerId);
});
frame.addEventListener('pointermove', event => {
  if(activePointers.has(event.pointerId))activePointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(pinch&&activePointers.size===2) {
    const points=[...activePointers.values()];
    setMagnification(pinch.zoom*Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y)/pinch.distance);return;
  }
  if(pinching)return;
  if (!drag || !pressStarted || drag.pointerId!==event.pointerId) return;
  if (drag.mode === 'reference') {
    const r=frame.getBoundingClientRect();placeTarget((event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height);return;
  }
  const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
  if (Math.hypot(dx,dy)<5 && !drag.moved) return;
  drag.moved=true;clearPlan('取景范围已改变，已恢复构图参考。');
  const {w,h}=size();state.panX=drag.panX-dx/drag.width*drag.crop.sw/w;state.panY=drag.panY-dy/drag.height*drag.crop.sh/h;
  syncSettings();draw();
});
frame.addEventListener('pointerup', event => {
  activePointers.delete(event.pointerId);
  if(pinching){pinch=null;pressStarted=false;drag=null;if(!activePointers.size)pinching=false;return;}
  if(drag&&drag.pointerId!==event.pointerId)return;
  if (pressStarted && drag?.mode === 'photo' && !drag.moved && state.crop) {
    const r=frame.getBoundingClientRect(),{w,h}=size();
    state.anchor={x:(state.crop.sx+(event.clientX-r.left)/r.width*state.crop.sw)/w,y:(state.crop.sy+(event.clientY-r.top)/r.height*state.crop.sh)/h};
    state.box=null;state.faceCount=0;state.personCount=0;state.sampleAnchor=false;++state.manualRevision;state.detectionPending=false;
    statusMessage(state.kind==='person'?'已标记实际脚点，只比较位置；没有人体框时不判断大小。':'已标记实际脸部中心，只比较位置，不判断身体裁切。');
    updateSourceUI();updateGuidance();
  }
  pressStarted=false;drag=null;
});
frame.addEventListener('pointercancel',()=>{pressStarted=false;drag=null;activePointers.clear();pinch=null;pinching=false;});
frame.addEventListener('keydown', event => {
  if (event.target.closest('button,input,.zoom-deck,.frame-intelligence')) return;
  const direction={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'}[event.key];
  if (direction && state.editingReference) {
    event.preventDefault();const target=currentTarget(),step=event.shiftKey?.05:.01;
    placeTarget(target.x+(direction==='left'?-step:direction==='right'?step:0),target.y+(direction==='up'?-step:direction==='down'?step:0));
  } else if (direction && state.source!=='camera') {event.preventDefault();nudge(direction);}
  if (event.key==='Escape' && state.editingReference) {state.editingReference=false;updateSourceUI();updateGuidance();}
  if (event.code==='Space') {event.preventDefault();shutter();}
});

const shotSubtitles={extreme_wide:'环境主导',wide:'人与环境',full:'头到脚',medium_full:'膝部以上',medium:'腰部以上',close:'胸部以上',detail:'脸部细节'};
$('shotList').innerHTML=SHOTS.map(s=>{const target=targetForShot({shot:s.id,preset:'center'});target.x=.5;const t=getShotTemplateTransform({shot:s.id,target,aspect:.75});return `<button class="shot-button${s.id===state.shot?' selected':''}" data-shot="${s.id}" aria-pressed="${s.id===state.shot}"><span class="shot-preview" aria-hidden="true"><span style="left:${t.left*100}%;top:${t.top*100}%;width:${t.width*100}%;height:${t.height*100}%">${renderPoseSvg('soft-front')}</span></span><strong>${s.name}</strong><small>${shotSubtitles[s.id]}</small></button>`;}).join('');
$('shotList').addEventListener('click',event=>{const button=event.target.closest('[data-shot]');if(button)changeShot(button.dataset.shot);});
for (const id of ['poseList','poseLibrary']) $(id).addEventListener('click',event=>{
  const button=event.target.closest('[data-pose]');if(!button)return;
  if(state.planTarget)clearPlan('动作已改变，请重新比较背景站位。');state.poseId=button.dataset.pose;renderPosePanel();updateGuidance();
});
$$('[data-scene]').forEach(button=>button.addEventListener('click',()=>{if(state.planTarget)clearPlan('场景与动作已改变，请重新比较背景站位。');state.scene=button.dataset.scene;state.poseId=null;renderPosePanel();updateGuidance();}));
$('nextPoseBtn').addEventListener('click',()=>{
  if(state.planTarget)clearPlan('动作已改变，请重新比较背景站位。');
  const poses=recommendPoses({scene:state.scene,shot:state.shot,limit:POSES.length});
  state.poseId=poses[(poses.findIndex(p=>p.id===state.poseId)+1)%poses.length].id;renderPosePanel();updateGuidance();
});
$('morePosesBtn').addEventListener('click',()=>{state.morePoses=!state.morePoses;renderPosePanel();});
$('mirrorPoseBtn').addEventListener('click',()=>{if(state.planTarget)clearPlan('动作朝向已改变，请重新比较背景站位。');state.poseFlipped=!state.poseFlipped;renderPosePanel();updateGuidance();});
$('showPoseBtn').addEventListener('click',()=>{state.poseVisible=!state.poseVisible;renderPosePanel();updateGuidance();});
$('poseOpacity').addEventListener('input',event=>{state.poseOpacity=Number(event.target.value)/100;$('poseOpacityValue').textContent=`${event.target.value}%`;updateGuidance();});
$$('[data-position]').forEach(button=>button.addEventListener('click',()=>{
  state.editingReference=true;const target=currentTarget();placeTarget({left:.3,center:.5,right:.7}[button.dataset.position],target.y,button.dataset.position);updateSourceUI();
}));
$('placeReferenceBtn').addEventListener('click',()=>{
  stopZoomMotion();closeInlineZoom();
  state.editingReference=!state.editingReference;cancelCountdown();updateSourceUI();updateGuidance();
  if(state.editingReference)frame.focus({preventScroll:true});
});
$('resetReferenceBtn').addEventListener('click',()=>{clearPlan();state.editingReference=false;updateSourceUI();updateGuidance();});
renderPosePanel();
camera.setDetectionMode(state.kind);

function pauseCameraForBackground() {
  stopZoomMotion();closeInlineZoom();workbench?.invalidate();cancelCountdown();
  activePointers.clear();pinch=null;pinching=false;drag=null;pressStarted=false;
  if (state.source === 'camera' || state.cameraPending) {
    ++state.operation; state.cameraPending = false; camera.stop();
    state.anchor = null; state.box = null;
    state.lastCameraStatus = { state: 'error', message: '离开页面后相机已关闭。回来后点击“重新开启相机”。' };
    statusMessage(state.lastCameraStatus.message); updateSourceUI(); updateGuidance();
  }
}
document.addEventListener('visibilitychange', () => {if(!nativeHost&&document.hidden)pauseCameraForBackground();});
window.addEventListener('qujing-native-pause',()=>{if(nativeHost)pauseCameraForBackground();});
window.addEventListener('qujing-native-back',event=>{
  if(!nativeHost)return;
  const dialog=dialogStack.filter(d=>d.open).at(-1);
  if(dialog){event.preventDefault();dialog.close();}
  else if(!$('zoomInline').hidden){event.preventDefault();closeInlineZoom();}
  else if(state.editingReference){event.preventDefault();finishPlacement();}
  else if(state.countdownId){event.preventDefault();cancelCountdown();}
});
const offlineManager=createOfflineManager({bundled:Boolean(nativeHost),onStatus(data){
  $('offlineStatus').textContent=data.message;
  $('offlineProgress').hidden=data.state!=='downloading';
  $('offlineProgress').max=Math.max(1,data.total||1);$('offlineProgress').value=data.completed||0;
  $('prepareOfflineBtn').disabled=data.state==='downloading';
  $('prepareOfflineBtn').hidden=Boolean(nativeHost);
  $('prepareOfflineBtn').textContent=data.ready?'检查离线资源':data.state==='error'||data.state==='incomplete'?'重新准备离线资源':'下载完整离线资源';
  $('offlineBadge').textContent=nativeHost?'离线版':data.ready?'已备好离线':'离线未就绪';
}});
$('prepareOfflineBtn').addEventListener('click',()=>offlineManager.prepare());
if(nativeHost) {
  $('downloadBtn').innerHTML='<svg><use href="#i-download"/></svg>保存照片';
  $('aboutTitle').textContent='取景相机 · Android 离线版';
  $('modelNetworkText').textContent='此 Android 安装包内置页面、检测库、模型和示例，不申请联网权限。首次使用和重新启动均从安装包读取；照片与视频帧在设备内处理。';
}
workbench=createPhotoWorkbench({
  getContext(){
    const reading=acceptedObservation();
    return {sourceMode:state.source,sourceKey:sourceKey(),zoomRevision:state.zoomRevision,
      media:state.source==='camera'?video:state.image,crop:currentCrop(),mirrored:state.mirrored,
      ready:state.source==='camera'?camera.running&&!state.cameraPending&&video.readyState>=2:Boolean(state.image?.naturalWidth),
      controlsPending:controlsPending(),zoomActive:Boolean(zoomFrameId),
      subjectBox:reading?.origin==='detected'&&reading.point?.visible&&reading.box?{...reading.box,kind:state.kind}:null,
      frameTime:state.source==='camera'?video.currentTime:null};
  },
  getExposure:()=>camera.getExposureState(),setExposure:value=>camera.setExposureCompensation(value),openDialog,
  onEffects(settings,filter){canvas.style.filter=filter;video.style.filter=filter;},
  onAnalysis(){updateCoordination();},toast,
});
workbench.start();
offlineManager.start();
window.addEventListener('pagehide', () => {stopZoomMotion();workbench?.dispose();camera.stop();cancelCountdown();clearTimeout(guidanceExpiryTimer);stabilizer.reset();offlineManager.dispose();nativeSaver?.dispose();});
new ResizeObserver(() => draw()).observe($('cameraStage'));
window.addEventListener('resize',draw);
demoImage.onload = () => { if (state.source === 'demo') useDemo(); };
demoImage.onerror = () => { if (state.source !== 'demo') return; $('viewNotice').textContent = '示例暂未加载。你可以开启相机或导入自己的照片。'; $('viewNotice').hidden = false; $('shutterBtn').disabled = true; };
demoImage.src = './assets/demo.jpg';
updateSourceUI();
