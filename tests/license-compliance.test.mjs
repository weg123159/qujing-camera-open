import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root = new URL('../', import.meta.url);
const text = async path => readFile(new URL(path, root), 'utf8');
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

test('released example JPEG assets match offline manifest', async () => {
  const manifest = JSON.parse(await text('dist/offline-manifest.json'));
  for (const file of ['demo.jpg', 'portrait.jpg']) {
    const path = 'assets/' + file;
    const entry = manifest.assets.find(item => item.url === path);
    assert.ok(entry, 'missing manifest asset ' + path);
    const bytes = await readFile(new URL('dist/' + path, root));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(hash(bytes), entry.sha256);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
  }
});

test('example images have declared original-generation provenance', async () => {
  const app = await text('dist/app.mjs');
  const readme = await text('README.md');
  const provenance = await text('docs/ASSET-PROVENANCE.md');
  assert.match(app, /AI 生成演示人像/);
  assert.match(readme, /网页版 ChatGPT/);
  assert.match(provenance, /ChatGPT/);
});

test('all third-party license viewer paths are bundled locally', async () => {
  const html = await text('dist/index.html');
  const app = await text('dist/app.mjs');
  const manifest = JSON.parse(await text('dist/offline-manifest.json'));
  assert.match(html, /id="licenseDialog"/);
  assert.match(html, /id="licenseBtn"/);
  assert.match(app, /licensePaths/);
  const paths = [...html.matchAll(/data-license-file="([^"]+)"/g)].map(match => match[1]);
  assert.equal(paths.length, 6);
  for (const path of paths) {
    assert.ok(manifest.assets.some(item => item.url === path), 'missing local license file ' + path);
  }
});

test('offline service worker stamps and manifest version are internally consistent', async () => {
  const manifest = JSON.parse(await text('dist/offline-manifest.json'));
  const worker = await text('dist/sw.js');
  assert.ok(worker.includes("const OFFLINE_BUILD = '" + manifest.version + "';"));
  assert.ok(worker.includes("const OFFLINE_WORKER_SOURCE_HASH = '" + manifest.workerHash + "';"));
  const normalized = worker.replace(/const OFFLINE_BUILD = '[^']+';/, "const OFFLINE_BUILD = 'BUILD_PENDING';")
    .replace(/const OFFLINE_WORKER_SOURCE_HASH = '[^']+';/, "const OFFLINE_WORKER_SOURCE_HASH = 'WORKER_PENDING';");
  assert.equal(hash(normalized), manifest.workerHash);
  assert.equal(hash(JSON.stringify({schema: 1, assets: manifest.assets, workerHash: manifest.workerHash})), manifest.version);
});

test('explicit third-party and generated-image provenance are retained', async () => {
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/ASSET-PROVENANCE.md', 'docs/RELEASE-COMPLIANCE.md']) {
    assert.ok((await text(file)).length > 100, 'missing compliance file ' + file);
  }
  assert.match(await text('docs/RELEASE-COMPLIANCE.md'), /BlazeFace/);
  assert.match(await text('THIRD_PARTY_NOTICES.md'), /官方模型卡/);
});
