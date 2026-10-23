import { EXACT } from './i18n-dict.mjs';
import { RUNTIME } from './i18n-runtime-dict.mjs';
import { POSE_TEXT } from './i18n-poses.mjs';
import { ENGINE_TEXT } from './i18n-engine.mjs';

// Offline-only presentation layer. Do not modify computation, model output or
// the LICENSE / NOTICE source files; only translate visible UI text and labels.
const SUPPORTED = new Set(['zh', 'en']);
const SKIP = 'script,style,pre,code,textarea,[data-i18n-ignore]';
const ATTRS = ['aria-label', 'aria-valuetext', 'alt', 'placeholder', 'title', 'content'];
const memory = new WeakMap();
const attributeMemory = new WeakMap();
let locale = 'zh';
let observer;

const variable = [
  [/^(快门参考|快门起点|ISO 参考|白平衡参考)：(.+?)。(.*)$/, (_, label, value, reason) =>
    localize(label, 'en') + ': ' + localize(value, 'en') + '. ' + localize(reason, 'en')],
  [/^(.+?。) (当前没有可靠人物区域，未进行人物区域测光。) 分析来自未加风格的取景画面。$/, (_, condition, region) =>
    localize(condition, 'en') + ' ' + localize(region, 'en') + ' Analysis uses the unstyled camera preview.'],
  [/^(.+?。) 人物区域亮度 (\S+)，背景 (\S+)。 区域亮度可能受衣服与背景影响。 分析来自未加风格的取景画面。$/, (_, condition, subject, background) =>
    localize(condition, 'en') + ' Subject brightness ' + subject + '; background ' + background +
    '. Clothing and background can affect the estimate. Analysis uses the unstyled preview.'],
  [/^(.+?。) 人物区域亮度 (\S+)；没有可用背景区域，不作逆光比较。 区域亮度可能受衣服与背景影响。 分析来自未加风格的取景画面。$/, (_, condition, subject) =>
    localize(condition, 'en') + ' Subject brightness ' + subject +
    '; no valid background region for comparison. Clothing and background can affect the estimate.'],
  [/^更多适用姿势 · (\d+)$/, (_, n) => 'More suitable poses · ' + n],
  [/^找到 (\d+) 个画面参考点。点击编号比较，确认后使用。$/, (_, n) => 'Found ' + n + ' candidate positions. Compare them, then choose one.'],
  [/^站位 (\d+)( · 优先参考)?$/, (_, n, first) => 'Position ' + n + (first ? ' · Suggested' : '')],
  [/^选择站位(\d+)$/, (_, n) => 'Choose position ' + n],
  [/^位置匹配 (\d+)%$/, (_, n) => 'Position match ' + n + '%'],
  [/^倍率 (.+)$/, (_, n) => 'Zoom ' + n],
  [/^切换画幅比例，当前(.+)$/, (_, ratio) => 'Change aspect ratio; currently ' + ratio],
  [/^正在寻找(人物|脸部)…$/, (_, kind) => 'Finding ' + (kind === '人物' ? 'person' : 'face') + '…'],
  [/^需要条件：(.+)$/, (_, condition) => 'Requires: ' + localize(condition, 'en')],
  [/^尝试 (.+) · 匹配人物占比$/, (_, zoom) => 'Try ' + zoom + ' · match subject scale'],
  [/^当前是站位预演，照片里的人物不会移动。现场拍摄时保持机位，参考火柴人调整(站位|脸部位置)。$/, (_, kind) => 'This is a placement preview, not an image edit. Keep the camera still and adjust ' + (kind === '站位' ? 'the subject position' : 'the face position') + ' to the guide.'],
  [/^(.+) · 已翻转$/, (_, name) => localize(name, 'en') + ' · Mirrored'],
  [/^(手机|镜头)向(左|右|上|下)微移$/, (_, actor, side) =>
    (actor === '手机' ? 'Move camera' : 'Move lens') + ' slightly ' + ({左:'left',右:'right',上:'up',下:'down'}[side])],
  [/^人物向画面(左|右|上|下)方调整$/, (_, side) =>
    'Move subject ' + ({左:'left',右:'right',上:'up',下:'down'}[side]) + ' in the frame'],
  [/^画面向(左|右|上|下)轻移$/, (_, side) =>
    'Shift the framing slightly ' + ({左:'left',右:'right',上:'up',下:'down'}[side])],
  [/^轻点或拖动来摆放(人物脚点|脸部中心)；完成后锁定参考。方向键也可以微调。$/, (_, kind) =>
    'Tap or drag to place ' + (kind === '人物脚点' ? 'the person foot-point' : 'the face-center') + ' reference. Finish to lock it; arrow keys fine-tune.'],
  [/^照片中轻点(脚下|脸部中心)可标记实际人物；如果正在编辑站位，先点“完成摆放”。$/, (_, kind) =>
    'Tap ' + (kind === '脚下' ? 'under the person' : 'the face center') + ' in the photo to mark a position. Finish placement mode first if needed.'],
  [/^(示例参考|手动参考|照片参考)已接近目标$/, (_, mode) =>
    localize(mode, 'en') + ' is near the target'],
  [/^(示例参考|手动参考|照片参考)只比较当前画面的位置(和参考大小)?，不代表实时检测稳定。(.*)$/, (_, mode, scale, detail) =>
    localize(mode, 'en') + ' only compares the current position' + (scale ? ' and scale' : '') +
    '; this does not prove stable live detection. ' + localize(detail, 'en')],
  [/^人物约占画面高度 (\d+)% ，?目标为 (\d+)%.*$/, (_, actual, target) =>
    'Person fills about ' + actual + '% of frame height; target ' + target + '%. Position and scale are separate.'],
  [/^人物约占画面高度 (\d+)%，目标为 (\d+)%。位置匹配度不包含大小判断。$/, (_, actual, target) =>
    'Person fills ' + actual + '% of frame height; target ' + target + '%. Position match excludes scale.'],
  [/^脸部约占画面高度 (\d+)%，参考为 (\d+)%；(.+)裁切仍需对照示意确认。$/, (_, actual, target, part) =>
    'Face fills ' + actual + '% of the frame; target ' + target + '%. Check ' + localize(part, 'en') + ' cropping manually.'],
  [/^只比较脸部参考框，不能由脸框确认(.+)裁切或人物姿态。$/, (_, part) =>
    'Only the face box is measured; it cannot verify ' + localize(part, 'en') + ' cropping or real pose.'],
  [/^相机当前没有可确认的(倍率|曝光补偿)控制能力。$/, (_, which) =>
    'No verified camera ' + (which === '倍率' ? 'zoom' : 'exposure compensation') + ' control is available.'],
  [/^相机未返回可确认的实际(倍率|曝光补偿)。$/, (_, which) =>
    'Camera did not report verified ' + (which === '倍率' ? 'zoom' : 'exposure compensation') + ' values.'],
  [/^相机未采用所选(倍率|曝光补偿)，已显示实际值。$/, (_, which) =>
    'Camera did not apply the requested ' + (which === '倍率' ? 'zoom' : 'exposure compensation') + '; actual value is shown.'],
  [/^当前相机无法采用这个(倍率|曝光补偿)，请重试或调整数值。$/, (_, which) =>
    'Camera could not apply that ' + (which === '倍率' ? 'zoom' : 'exposure compensation') + ' value; try another value.'],
  [/^曝光补偿已调整为 (.+)$/, (_, ev) => 'Exposure compensation set to ' + ev],
  [/^设备实际曝光补偿 (.+)；范围 (.+) 至 (.+)。$/, (_, value, min, max) =>
    'Verified device exposure compensation: ' + value + '; supported range ' + min + ' to ' + max + '.'],
  [/^建议相对当前 (.+)$/, (_, value) => 'Suggested relative change: ' + value],
  [/^(.+) · 松手应用$/, (_, ev) => ev + ' · Release to apply'],
  [/^无法检查离线资源：(.+)$/, (_, error) => 'Cannot check offline assets: ' + localize(error, 'en')],
  [/^离线准备未完成：(.+)$/, (_, error) => 'Offline preparation incomplete: ' + localize(error, 'en')],
  [/^当前参考高度 (\d+)%；范围是产品约定，不是实际距离。$/, (_, amount) =>
    'Reference height ' + amount + '% is a product framing convention, not real-world distance.'],
  [/^当前参考约占高度 (\d+)%；(.+)采用 (\d+)–(\d+)% 的项目参考范围，可保留自定义取景或改选景别。$/, (_, actual, name, min, max) =>
    'Current height ' + actual + '%. ' + localize(name, 'en') + ' uses a ' + min + '–' + max + '% reference range; you can keep custom framing.'],
  [/^(.+) · (.+)$/, (_, left, right) => {
    const l = localize(left, 'en');
    const r = localize(right, 'en');
    return l === left && r === right ? null : l + ' · ' + r;
  }],
  [/^照片练习 · 点选(实际脚点|脸部中心)，拖动调整画面$/, (_, kind) => 'Photo practice · mark ' + (kind === '实际脚点' ? 'the foot point' : 'the face center') + ', then drag to reframe'],
  [/^实时 · (人体|人脸)辅助$/, (_, kind) => 'Live · ' + (kind === '人体' ? 'person' : 'face') + ' guidance'],
  [/^([^-]+) · (\d+) × (\d+)$/, (_, style, w, h) => localize(style, 'en') + ' · ' + w + ' × ' + h],
  [/^正在准备 (.+)$/, (_, remaining) => 'Preparing ' + localize(remaining, 'en')]
];

export function localize(text, language = 'en') {
  if (language !== 'en' || typeof text !== 'string' || !/[\u3400-\u9fff]/u.test(text)) return text;
  const head = text.match(/^\s*/u)?.[0] ?? '';
  const tail = text.match(/\s*$/u)?.[0] ?? '';
  const source = text.slice(head.length, text.length - tail.length);
  if (!source) return text;
  const translated = EXACT[source] ?? RUNTIME[source] ?? POSE_TEXT[source] ?? ENGINE_TEXT[source];
  if (translated) return head + translated + tail;
  for (const [regex, fn] of variable) {
    const match = source.match(regex);
    if (!match) continue;
    const result = fn(...match);
    if (result) return head + result + tail;
  }
  return text;
}

function isSkipped(node) {
  const parent = node.nodeType === 3 ? node.parentElement : node;
  return !parent || !!parent.closest?.(SKIP);
}

function updateNode(node) {
  if (node.nodeType !== 3 || isSkipped(node)) return;
  const current = node.nodeValue ?? '';
  const prior = memory.get(node);
  const original = prior && current === prior.rendered ? prior.original : current;
  const rendered = localize(original, locale);
  memory.set(node, { original, rendered });
  if (rendered !== current) node.nodeValue = rendered;
}

function updateAttributes(element) {
  if (element.nodeType !== 1 || element.closest(SKIP)) return;
  let state = attributeMemory.get(element);
  if (!state) { state = new Map(); attributeMemory.set(element, state); }
  for (const attr of ATTRS) {
    const current = element.getAttribute(attr);
    if (current === null) continue;
    if (attr === 'content' && element.tagName !== 'META') continue;
    const prior = state.get(attr);
    const original = prior && current === prior.rendered ? prior.original : current;
    const rendered = localize(original, locale);
    state.set(attr, { original, rendered });
    if (rendered !== current) element.setAttribute(attr, rendered);
  }
}

function visit(root) {
  if (!root || isSkipped(root)) return;
  if (root.nodeType === 3) { updateNode(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9) return;
  if (root.nodeType === 1) updateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let item;
  while ((item = walker.nextNode())) {
    if (isSkipped(item)) continue;
    if (item.nodeType === 3) updateNode(item);
    else updateAttributes(item);
  }
}

function setPressed() {
  document.querySelectorAll('[data-lang]').forEach(button => {
    const selected = button.dataset.lang === locale;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('selected', selected);
  });
  document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
}

export function setLanguage(language, { persist = true } = {}) {
  if (!SUPPORTED.has(language)) return false;
  locale = language;
  setPressed();
  visit(document.documentElement);
  if (persist) {
    try { localStorage.setItem('qujing-language', language); } catch { /* storage may be unavailable */ }
  }
  return true;
}

export function currentLanguage() { return locale; }

function initialize() {
  const saved = (() => { try { return localStorage.getItem('qujing-language'); } catch { return null; } })();
  const query = new URLSearchParams(location.search).get('lang');
  const preferred = SUPPORTED.has(query) ? query : SUPPORTED.has(saved) ? saved : 'zh';
  document.querySelectorAll('[data-lang]').forEach(button => {
    button.addEventListener('click', () => setLanguage(button.dataset.lang));
  });
  setLanguage(preferred, { persist: false });
  observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') updateNode(record.target);
      else if (record.type === 'attributes') updateAttributes(record.target);
      else for (const node of record.addedNodes) visit(node);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ATTRS
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
}
