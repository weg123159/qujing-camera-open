import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { localize, currentLanguage } from '../dist/i18n.mjs';
import { EXACT } from '../dist/i18n-dict.mjs';
import { RUNTIME } from '../dist/i18n-runtime-dict.mjs';
import { POSE_TEXT } from '../dist/i18n-poses.mjs';
import { ENGINE_TEXT } from '../dist/i18n-engine.mjs';

const source = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, source), 'utf8');

test('Chinese is the default and English translations are available offline', () => {
  assert.equal(currentLanguage(), 'zh');
  assert.equal(localize('取景'), 'Qujing');
  assert.equal(localize('构图方式'), 'Composition method');
  assert.equal(localize('近景'), 'Close shot');
  assert.equal(localize('亮部接近溢出'), 'Highlights near clipping');
  assert.equal(localize('靠墙放松'), 'Relaxed wall lean');
  assert.equal(localize('人物向画面左方调整'), 'Move subject left in the frame');
  assert.equal(localize('镜头向右微移'), 'Move lens slightly right');
});

test('Language translation preserves source semantics and whitespace', () => {
  assert.equal(localize('  拍照  '), '  Photo  ');
  assert.equal(localize('拍照', 'zh'), '拍照');
  assert.equal(localize('Take photo'), 'Take photo');
  assert.equal(localize('不存在的预设词'), '不存在的预设词');
  assert.equal(localize('位置匹配 86%'), 'Position match 86%');
  assert.equal(localize('更多适用姿势 · 6'), 'More suitable poses · 6');
  assert.equal(localize('站位 2 · 优先参考'), 'Position 2 · Suggested');
  assert.equal(localize('取景相机 · Android 离线版'), 'Qujing Camera · Android offline edition');
});

test('Core, pose and engine translations are checked-in local source', async () => {
  assert.ok(Object.keys(EXACT).length > 230);
  assert.ok(Object.keys(RUNTIME).length > 230);
  assert.ok(Object.keys(POSE_TEXT).length >= 70);
  assert.ok(Object.keys(ENGINE_TEXT).length > 200);
  const core = await read('dist/i18n.mjs');
  assert.match(core, /MutationObserver/);
  assert.match(core, /localStorage/);
  assert.doesNotMatch(core, /fetch\(|XMLHttpRequest|https?:\/\//);
});

test('Language selector and Android English app name exist', async () => {
  const html = await read('dist/index.html');
  assert.match(html, /data-lang="zh"/);
  assert.match(html, /data-lang="en"/);
  assert.ok(html.indexOf('src="./i18n.mjs"') < html.indexOf('src="./app.mjs"'));
  assert.match(await read('android/res/values-en/strings.xml'), /Qujing Camera/);
  assert.match(await read('README.md'), /README\.en\.md/);
  assert.match(await read('README.en.md'), /中文/);
});

test('Composed lighting messages and camera hints translate without dropping numbers', () => {
  const balanced = '当前像素没有显示明显的大片高光或暗部问题，可按风格调整。 当前没有可靠人物区域，未进行人物区域测光。 分析来自未加风格的取景画面。';
  const english = localize(balanced);
  assert.match(english, /No major highlight or shadow problems/);
  assert.doesNotMatch(english, /[\u3400-\u9fff]/u);
  const hint = localize('快门参考：自动优先，留意人物轻微移动。没有实际运动与防抖数据，固定快门值不能保证清晰。');
  assert.match(hint, /Shutter reference:/);
  assert.doesNotMatch(hint, /[\u3400-\u9fff]/u);
  assert.equal(localize('人物向画面左方调整'), 'Move subject left in the frame');
});

test('Local development server and bundled-license event handlers remain functional', async () => {
  const server = await read('scripts/dev-server.py');
  assert.match(server, /text\/javascript/);
  assert.match(server, /application\/wasm/);
  const app = await read('dist/app.mjs');
  assert.equal((app.match(/\$\$\('\[data-license-file\]'\)/g) ?? []).length, 3);
});
