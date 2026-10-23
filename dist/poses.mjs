/**
 * Authored pose references, not pose detection. Scene and shot are the user's
 * choices; no image, identity, gender or physical capability is inferred.
 *
 * Geometry is shared by every shot crop. Canonical body y = (svgY - 10) / 470;
 * the SVG's padding is not part of the person's height. All colors inherit.
 */

export const POSE_COORDINATES = Object.freeze({
  viewBox: '0 0 200 500', width: 200, height: 500,
  headTop: 10, feetY: 480, bodyHeight: 470,
  faceCenter: Object.freeze({x: 100, y: 45}),
  shoulders: Object.freeze({x: 100, y: 130}),
  waist: Object.freeze({x: 100, y: 265}),
  canonicalFaceY: 35 / 470,
});

const ALL_SCENES = ['travel', 'urban', 'indoor', 'studio'];
const SHOTS = ['extreme_wide', 'wide', 'full', 'medium_full', 'medium', 'close', 'detail'];

const catalog = [
  {
    id: 'easy-angle', name: '侧身轻站', sceneTags: ALL_SCENES,
    shotTags: ['full', 'medium_full', 'wide', 'medium', 'extreme_wide'],
    shortReason: '错开一点肩线和脚步，站着也有自然的层次。',
    cues: {body: '身体稍侧向镜头，重心放在后面的脚。', hands: '双手自然垂下，手臂和腰之间留一点空隙。', gaze: '脸轻轻转回镜头，下巴保持放松。'},
  },
  {
    id: 'forward-step', name: '向前迈步', sceneTags: ['travel', 'urban', 'studio'],
    shotTags: ['full', 'wide', 'medium_full', 'extreme_wide'],
    shortReason: '迈步的轮廓在远处也清楚，适合道路和开阔背景。',
    cues: {body: '沿着镜头前方缓缓迈一小步，不必走得很快。', hands: '手臂随脚步轻摆，一前一后即可。', gaze: '看向前方一点，像正走向要去的地方。'},
  },
  {
    id: 'look-back', name: '回身一眼', sceneTags: ['travel', 'urban', 'indoor'],
    shotTags: ['full', 'medium_full', 'wide', 'medium', 'close'],
    shortReason: '让身体与视线朝向不同，画面像一个刚好捕捉到的瞬间。',
    cues: {body: '背部斜对镜头，再从舒服的一侧轻轻回头。', hands: '一只手自然垂下，另一只手轻搭身侧。', gaze: '视线越过肩膀看向镜头，不必勉强转动脖子。'},
  },
  {
    id: 'open-view', name: '迎风舒展', sceneTags: ALL_SCENES,
    shotTags: ['extreme_wide', 'wide', 'full'],
    shortReason: '展开的手臂让小人物也有清晰轮廓，适合留出更多环境。',
    cues: {body: '双脚稍分开，身体站稳，肩膀放松。', hands: '双臂向两侧打开，手肘保留一点弯曲。', gaze: '望向眼前的景色，或轻轻抬眼看远处。'},
  },
  {
    id: 'far-gaze', name: '侧身远望', sceneTags: ALL_SCENES,
    shotTags: ['wide', 'extreme_wide', 'full', 'medium_full', 'medium', 'close', 'detail'],
    shortReason: '把视线留给画面的一侧，适合风景、窗边和有留白的构图。',
    cues: {body: '身体转向一侧，前后脚稍微错开。', hands: '双手轻放在身后，肩膀不要向后夹紧。', gaze: '平视侧前方，顺着画面的留白看出去。'},
  },
  {
    id: 'pocket-rest', name: '单手搭腰', sceneTags: ['urban', 'travel', 'studio'],
    shotTags: ['full', 'medium_full', 'medium'],
    shortReason: '一侧手臂形成折线，适合突出衣服和站姿的轮廓。',
    cues: {body: '重心放在一条腿上，另一只脚轻轻向前。', hands: '一只手松松搭在腰侧，另一只手自然垂下。', gaze: '脸稍转向镜头，目光放松地看过来。'},
  },
  {
    id: 'wall-lean', name: '靠墙放松', sceneTags: ['urban', 'indoor', 'studio'],
    shotTags: ['full', 'medium_full', 'wide', 'medium'], needsProp: '稳固墙面',
    shortReason: '借墙面让身体有一个支点，手脚更容易放松。',
    cues: {body: '侧身靠近墙面，让靠墙的上臂轻靠墙，一只脚略收起。', hands: '靠墙的手轻触墙面，另一只手放在身侧。', gaze: '看向镜头旁边，像在等一个人。'},
  },
  {
    id: 'folded-arms', name: '轻抱双臂', sceneTags: ['urban', 'indoor', 'studio'],
    shotTags: ['medium', 'medium_full', 'close'],
    shortReason: '手臂集中在上半身，适合简洁、有精神的半身照。',
    cues: {body: '身体稍侧向镜头，肩膀自然下沉。', hands: '双臂轻轻交叠，手指放松，不要用力抱紧。', gaze: '平视镜头，嘴角和下巴都放松。'},
  },
  {
    id: 'collar-touch', name: '轻理衣领', sceneTags: ['urban', 'indoor', 'studio'],
    shotTags: ['close', 'medium'],
    shortReason: '把手放到衣领附近，近景里也有一个自然的小动作。',
    cues: {body: '肩膀放低，身体稍微转出一个角度。', hands: '双手轻碰衣领或肩前的衣料，不要拉扯。', gaze: '先低头看一下手，再把视线慢慢抬向镜头。'},
  },
  {
    id: 'chin-rest', name: '指尖托下巴', sceneTags: ['indoor', 'studio', 'urban'],
    shotTags: ['close', 'detail', 'medium'],
    shortReason: '手势靠近面部，适合把注意力放在表情上的近景。',
    cues: {body: '上身保持舒展，头轻轻偏向舒服的一侧。', hands: '一只手的指尖轻碰下巴，另一只手托住手肘。', gaze: '看向镜头附近一点，像正听对方说话。'},
  },
  {
    id: 'temple-touch', name: '手到耳侧', sceneTags: ALL_SCENES,
    shotTags: ['close', 'detail', 'medium'],
    shortReason: '手与脸都留在近景里，让表情之外多一点动作。',
    cues: {body: '身体稍侧，肩膀保持放松。', hands: '一只手轻碰耳侧，手肘向外打开一点，另一只手放下。', gaze: '眼神看向镜头，或顺着脸朝向的一侧。'},
  },
  {
    id: 'cup-hold', name: '双手捧杯', sceneTags: ['indoor', 'urban', 'studio'],
    shotTags: ['medium', 'close', 'medium_full'], needsProp: '杯子',
    shortReason: '双手有了自然的落点，适合咖啡馆或室内的轻松画面。',
    cues: {body: '上身稍侧，肩膀放松，手肘自然向下。', hands: '双手轻托杯子，放在胸口附近，别挡住下巴。', gaze: '看一下杯子，再看向镜头或窗外。'},
  },
  {
    id: 'soft-front', name: '正面放松', sceneTags: ALL_SCENES,
    shotTags: ['detail', 'close', 'medium'],
    shortReason: '用简单的正面角度留住表情，适合干净的头像与面部特写。',
    cues: {body: '脸朝向镜头，肩膀放平，下巴轻轻收回一点。', hands: '双手放在画面外或自然垂下，让注意力留在脸上。', gaze: '平视镜头，像在看一位熟悉的人。'},
  },
  {
    id: 'three-quarter', name: '三分之二侧脸', sceneTags: ALL_SCENES,
    shotTags: ['detail', 'close', 'medium'],
    shortReason: '保留两侧眼睛和一点侧面轮廓，让面部方向更有层次。',
    cues: {body: '脸缓缓转向一侧，停在两只眼睛仍能看到的位置。', hands: '双手自然放低，肩膀不要跟着抬起。', gaze: '顺着脸的方向看向镜头旁边一点。'},
  },
];

export const POSES = Object.freeze(catalog.map(pose => Object.freeze({
  ...pose,
  sceneTags: Object.freeze([...pose.sceneTags]),
  shotTags: Object.freeze([...pose.shotTags]),
  cues: Object.freeze({...pose.cues}),
})));

const byId = new Map(POSES.map(pose => [pose.id, pose]));

export function getPose(id) { return byId.get(id) || null; }

const shotOrder = {
  extreme_wide: ['open-view', 'far-gaze', 'forward-step', 'easy-angle'],
  wide: ['forward-step', 'open-view', 'far-gaze', 'look-back', 'easy-angle', 'wall-lean'],
  full: ['easy-angle', 'forward-step', 'look-back', 'pocket-rest', 'wall-lean', 'open-view', 'far-gaze'],
  medium_full: ['easy-angle', 'pocket-rest', 'look-back', 'folded-arms', 'cup-hold', 'wall-lean', 'forward-step', 'far-gaze'],
  medium: ['folded-arms', 'easy-angle', 'cup-hold', 'collar-touch', 'chin-rest', 'temple-touch', 'three-quarter', 'soft-front', 'pocket-rest', 'wall-lean', 'look-back', 'far-gaze'],
  close: ['three-quarter', 'soft-front', 'temple-touch', 'chin-rest', 'collar-touch', 'cup-hold', 'look-back', 'folded-arms', 'far-gaze'],
  detail: ['three-quarter', 'soft-front', 'temple-touch', 'chin-rest', 'far-gaze'],
};
const sceneOrder = {
  travel: ['open-view', 'forward-step', 'look-back', 'far-gaze', 'easy-angle', 'temple-touch', 'three-quarter', 'soft-front'],
  urban: ['wall-lean', 'pocket-rest', 'forward-step', 'collar-touch', 'three-quarter', 'folded-arms', 'look-back', 'easy-angle'],
  indoor: ['cup-hold', 'chin-rest', 'soft-front', 'temple-touch', 'easy-angle', 'folded-arms', 'far-gaze', 'three-quarter'],
  studio: ['easy-angle', 'folded-arms', 'three-quarter', 'soft-front', 'collar-touch', 'open-view', 'chin-rest', 'temple-touch'],
};
const preference = (list, id) => {
  const index = list.indexOf(id);
  return index < 0 ? 0 : list.length - index;
};

/**
 * Deterministic authored recommendations. Every result fits the selected shot;
 * matching scene tags come first. Other scenes may fill remaining places, as a
 * pose can be adapted. Props are explicit metadata, never inferred as present.
 */
export function recommendPoses({scene = 'travel', shot = 'full', limit = 6} = {}) {
  const selectedScene = ALL_SCENES.includes(scene) ? scene : 'travel';
  const selectedShot = SHOTS.includes(shot) ? shot : 'full';
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(POSES.length, Math.floor(limit))) : 6;
  const score = pose => (pose.sceneTags.includes(selectedScene) ? 1000 : 0)
    + preference(shotOrder[selectedShot], pose.id) * 5
    + preference(sceneOrder[selectedScene], pose.id) * 2
    - (pose.needsProp ? 2 : 0);
  return POSES.filter(pose => pose.shotTags.includes(selectedShot))
    .sort((a, b) => score(b) - score(a) || POSES.indexOf(a) - POSES.indexOf(b))
    .slice(0, count);
}

// Original joint-based reference drawings. These are authored targets, not
// estimated or tracked body landmarks. A shared rig keeps all seven crops aligned.
const n = value => String(Math.round(value * 100) / 100);
const point = ([x, y]) => `${n(x)} ${n(y)}`;
const path = (d, extra = '') => `<path d="${d}" ${extra}/>`;
const line = (points, extra = '') => path(`M ${points.map(point).join(' L ')}`, extra);
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function joint(name, [x, y], radius = 4.5, opacity = 1) {
  return `<circle data-joint="${name}" cx="${n(x)}" cy="${n(y)}" r="${radius}" fill="currentColor" fill-opacity="${opacity}" stroke="none"/>`;
}

function head(type = 'front', gaze = false) {
  const circle = '<circle data-part="head" cx="100" cy="45" r="35" fill="none"/>';
  let face;
  if (type === 'profile') {
    face = '<circle cx="124" cy="42" r="2" fill="currentColor" stroke="none"/>'
      + path('M 128 48 L 136 53 L 128 56', 'stroke-width="2.3"');
  } else if (type === 'three-quarter' || type === 'back-look') {
    face = '<circle cx="103" cy="42" r="2" fill="currentColor" stroke="none"/><circle cx="120" cy="42" r="1.8" fill="currentColor" stroke="none"/>'
      + path('M 116 47 L 122 54 L 116 55', 'stroke-width="2.3"');
  } else {
    face = '<circle cx="89" cy="42" r="2" fill="currentColor" stroke="none"/><circle cx="111" cy="42" r="2" fill="currentColor" stroke="none"/>'
      + path('M 100 48 L 100 56', 'stroke-width="2.3"');
  }
  if (gaze) face += path('M 145 45 L 177 45 M 171 39 L 177 45 L 171 51', 'data-part="gaze" stroke-opacity=".7" stroke-width="2.3"');
  return circle + (type === 'back-look'
    ? `<g data-part="face" transform="translate(200 0) scale(-1 1)">${face}</g>`
    : `<g data-part="face">${face}</g>`);
}

function foot([x, y, direction]) {
  // Every supporting foot finishes at y=480, with the ankle visibly above it.
  return line([[x, y], [x + direction * 7, y + 12], [x + direction * 22, y + 12]], 'data-part="foot"');
}

const standLegs = [
  {points: [[86, 281], [83, 377], [82, 468]], foot: [82, 468, -1]},
  {points: [[114, 281], [118, 377], [118, 468]], foot: [118, 468, 1]},
];
const relaxedArms = [
  {points: [[68, 135], [57, 211], [65, 279]], hand: [65, 285, -7]},
  {points: [[132, 135], [144, 210], [136, 278]], hand: [136, 284, 8]},
];

const figures = {
  'easy-angle': {
    torso: 'angle', head: 'three-quarter',
    legs: [
      {points: [[96, 283], [93, 377], [89, 468]], foot: [89, 468, -1]},
      {points: [[119, 282], [127, 372], [140, 468]], foot: [140, 468, 1]},
    ],
    arms: [
      {points: [[69, 135], [57, 213], [69, 283]], hand: [70, 289, -8]},
      {points: [[132, 137], [151, 211], [146, 275]], hand: [146, 281, 5]},
    ],
  },
  'forward-step': {
    torso: 'angle', head: 'three-quarter',
    legs: [
      {points: [[118, 282], [133, 367], [151, 454]], foot: [151, 454, 1]},
      {points: [[93, 282], [69, 374], [52, 468]], foot: [52, 468, -1]},
    ],
    arms: [
      {points: [[132, 135], [156, 192], [152, 253]], hand: [152, 259, 4], behind: true},
      {points: [[69, 135], [41, 197], [80, 225]], hand: [85, 228, -55]},
    ],
  },
  'look-back': {
    torso: 'back', head: 'back-look', gaze: true,
    legs: [
      {points: [[87, 283], [96, 377], [112, 468]], foot: [112, 468, 1]},
      {points: [[113, 282], [99, 373], [82, 468]], foot: [82, 468, -1]},
    ],
    arms: [
      {points: [[70, 135], [52, 205], [68, 279]], hand: [69, 285, -11]},
      {points: [[132, 135], [158, 204], [124, 255]], hand: [120, 260, 32]},
    ],
  },
  'open-view': {
    torso: 'straight', head: 'front',
    legs: [
      {points: [[86, 282], [74, 375], [65, 468]], foot: [65, 468, -1]},
      {points: [[114, 282], [126, 375], [135, 468]], foot: [135, 468, 1]},
    ],
    arms: [
      {points: [[69, 133], [39, 116], [22, 89]], hand: [19, 83, -24, true]},
      {points: [[131, 133], [163, 113], [180, 84]], hand: [183, 78, 24, true]},
    ],
  },
  'far-gaze': {
    torso: 'angle', head: 'profile', gaze: true,
    legs: [
      {points: [[94, 283], [91, 376], [90, 468]], foot: [90, 468, -1]},
      {points: [[119, 282], [129, 373], [144, 468]], foot: [144, 468, 1]},
    ],
    arms: [
      {points: [[69, 135], [52, 208], [89, 252]], hand: [93, 257, -35], behind: true},
      {points: [[132, 136], [153, 206], [124, 257]], hand: [121, 263, 28], behind: true},
    ],
  },
  'pocket-rest': {
    torso: 'angle', head: 'three-quarter',
    legs: [
      {points: [[95, 283], [88, 377], [83, 468]], foot: [83, 468, -1]},
      {points: [[119, 282], [134, 371], [122, 468]], foot: [122, 468, 1]},
    ],
    arms: [
      {points: [[69, 135], [53, 208], [59, 280]], hand: [59, 286, -4]},
      {points: [[132, 135], [162, 199], [126, 253]], hand: [122, 259, 32]},
    ],
  },
  'wall-lean': {
    torso: 'lean', head: 'three-quarter',
    behind: path('M 168 105 L 168 480', 'data-part="prop" stroke-opacity=".35" stroke-width="2"'),
    legs: [
      {points: [[106, 285], [95, 379], [85, 468]], foot: [85, 468, -1]},
      {points: [[131, 283], [151, 351], [141, 409]], foot: [141, 409, 1]},
    ],
    arms: [
      {points: [[73, 138], [62, 209], [77, 280]], hand: [78, 286, -12]},
      {points: [[137, 136], [158, 201], [164, 152]], hand: [168, 145, 0]},
    ],
  },
  'folded-arms': {
    torso: 'angle', head: 'front', legs: standLegs,
    arms: [
      {points: [[69, 136], [57, 207], [128, 180]], hand: [133, 178, 66]},
      {points: [[132, 136], [143, 214], [75, 190]], hand: [70, 188, -69]},
    ],
  },
  'collar-touch': {
    torso: 'straight', head: 'three-quarter', legs: standLegs,
    arms: [
      {points: [[69, 136], [46, 204], [85, 123]], hand: [88, 116, 25]},
      {points: [[132, 136], [153, 202], [115, 123]], hand: [112, 116, -25]},
    ],
  },
  'chin-rest': {
    torso: 'angle', head: 'front', legs: standLegs,
    arms: [
      {points: [[69, 136], [61, 218], [140, 204]], hand: [146, 203, 80]},
      {points: [[132, 136], [146, 200], [119, 76]], hand: [114, 72, -18]},
    ],
  },
  'temple-touch': {
    torso: 'angle', head: 'three-quarter', legs: standLegs,
    arms: [
      {points: [[69, 136], [56, 211], [66, 279]], hand: [67, 285, -8]},
      {points: [[132, 136], [177, 104], [139, 64]], hand: [133, 58, -32]},
    ],
  },
  'cup-hold': {
    torso: 'straight', head: 'front', legs: standLegs,
    arms: [
      {points: [[69, 136], [55, 198], [83, 138]], hand: [85, 132, 20]},
      {points: [[132, 136], [146, 198], [117, 138]], hand: [115, 132, -20]},
    ],
    prop: 'cup',
    foreground: path('M 88 114 L 90 146 Q 100 150 110 146 L 112 114 Z M 112 120 Q 125 118 123 129 Q 122 137 112 136', 'data-part="prop" stroke-width="2.5"'),
  },
  'soft-front': {torso: 'straight', head: 'front', legs: standLegs, arms: relaxedArms},
  'three-quarter': {
    torso: 'angle', head: 'three-quarter', gaze: true, legs: standLegs,
    arms: [
      {points: [[69, 136], [60, 212], [75, 278]], hand: [76, 284, -12]},
      {points: [[132, 136], [147, 207], [137, 274]], hand: [136, 280, 10]},
    ],
  },
};

function drawFigure(figure) {
  const shoulders = figure.arms.map(arm => arm.points[0]);
  const hips = figure.legs.map(leg => leg.points[0]);
  const chest = midpoint(...shoulders), pelvis = midpoint(...hips);
  const neck = [100, 106];
  // Leave a small gap under the cup so its simple outline stays readable.
  const spine = figure.prop === 'cup'
    ? line([[100, 80], neck, [100, 108]], 'data-part="spine"')
      + line([[chest[0], 154], pelvis], 'data-part="spine"')
    : line([[100, 80], neck, chest, pelvis], 'data-part="spine"');
  const shoulderBar = figure.prop === 'cup'
    ? line([shoulders[0], [82, chest[1]]], 'data-part="shoulders"')
      + line([[118, chest[1]], shoulders[1]], 'data-part="shoulders"')
    : line(shoulders, 'data-part="shoulders"');
  const hipBar = line(hips, 'data-part="hips"');
  const legs = figure.legs.map((leg, index) => line(leg.points, `data-part="leg-${index + 1}"`) + foot(leg.foot)).join('');
  const arms = figure.arms.map((arm, index) =>
    line(arm.points, `data-part="arm-${index + 1}"${arm.behind ? ' stroke-opacity=".6"' : ''}`)
    + line([arm.points[2], arm.hand.slice(0, 2)], `data-part="hand-${index + 1}"${arm.behind ? ' stroke-opacity=".6"' : ''}`),
  ).join('');
  const joints = joint('neck', neck, 3.8)
    + figure.arms.map((arm, index) => arm.points.map((p, part) =>
      joint(`${['shoulder', 'elbow', 'wrist'][part]}-${index + 1}`, p, part === 2 ? 4.1 : 4.5, arm.behind ? .65 : 1),
    ).join('')).join('')
    + figure.legs.map((leg, index) => leg.points.map((p, part) =>
      joint(`${['hip', 'knee', 'ankle'][part]}-${index + 1}`, p),
    ).join('')).join('');
  return (figure.behind || '') + `<g data-part="skeleton">${spine}${shoulderBar}${hipBar}${legs}${arms}</g>`
    + head(figure.head, figure.gaze) + (figure.foreground || '') + joints;
}

const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));

/** Complete responsive SVG; mirror changes geometry only, never the cues. */
export function renderPoseSvg(id, {mirror = false} = {}) {
  const pose = getPose(id);
  if (!pose) return '';
  const transform = mirror ? ' transform="translate(200 0) scale(-1 1)"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 500" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeXml(pose.name)} · 姿势参考" focusable="false" style="display:block;overflow:visible"><title>${escapeXml(pose.name)} · 姿势参考</title><g${transform} fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">${drawFigure(figures[id])}</g></svg>`;
}
