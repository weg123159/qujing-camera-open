import test from 'node:test';
import assert from 'node:assert/strict';
import {POSES, POSE_COORDINATES, getPose, recommendPoses, renderPoseSvg} from '../dist/poses.mjs';

const scenes = ['travel', 'urban', 'indoor', 'studio'];
const shots = ['extreme_wide', 'wide', 'full', 'medium_full', 'medium', 'close', 'detail'];

test('catalog provides 14 distinct, gender-neutral references with three usable cues', () => {
  assert.equal(POSES.length, 14);
  assert.equal(new Set(POSES.map(pose => pose.id)).size, POSES.length);
  for (const pose of POSES) {
    assert.ok(pose.name && pose.shortReason);
    assert.deepEqual(Object.keys(pose.cues).sort(), ['body', 'gaze', 'hands']);
    assert.ok(Object.values(pose.cues).every(cue => typeof cue === 'string' && cue.length >= 12));
    assert.ok(pose.sceneTags.length && pose.sceneTags.every(scene => scenes.includes(scene)));
    assert.ok(pose.shotTags.length && pose.shotTags.every(shot => shots.includes(shot)));
    // Mirroring must not turn a textual left/right instruction into its inverse.
    assert.doesNotMatch(Object.values(pose.cues).join(''), /左手|右手|左脚|右脚|男性|女性|男生|女生/);
  }
});

test('all 28 scene/shot combinations offer at least one matching reference', () => {
  for (const scene of scenes) for (const shot of shots) {
    const result = recommendPoses({scene, shot});
    assert.ok(result.length > 0, `${scene}/${shot}`);
    assert.ok(result[0].sceneTags.includes(scene), `${scene}/${shot} first scene`);
    assert.ok(result.every(pose => pose.shotTags.includes(shot)), `${scene}/${shot} crop compatibility`);
    let hasCrossedIntoOtherScenes = false;
    for (const pose of result) {
      if (!pose.sceneTags.includes(scene)) hasCrossedIntoOtherScenes = true;
      else assert.equal(hasCrossedIntoOtherScenes, false, 'matching scene must rank before fallback scenes');
    }
  }
});

test('recommendations are deterministic and scene choice changes the ordering', () => {
  const ids = scene => recommendPoses({scene, shot: 'medium'}).map(pose => pose.id);
  assert.deepEqual(ids('indoor'), ids('indoor'));
  assert.notDeepEqual(ids('indoor'), ids('travel'));
  assert.notDeepEqual(ids('indoor'), ids('studio'));
  assert.equal(recommendPoses({scene: 'travel', shot: 'extreme_wide'})[0].id, 'open-view');
});

test('detail references include explicit frontal and three-quarter faces, without full-body-only actions', () => {
  const poses = recommendPoses({scene: 'studio', shot: 'detail', limit: 14});
  assert.ok(poses.some(pose => pose.id === 'soft-front'));
  assert.ok(poses.some(pose => pose.id === 'three-quarter'));
  assert.ok(poses.some(pose => pose.id === 'temple-touch'));
  assert.ok(poses.every(pose => !['forward-step', 'open-view', 'wall-lean', 'cup-hold', 'collar-touch'].includes(pose.id)));
});

test('limits, invalid selections and missing ids have predictable safe behavior', () => {
  assert.equal(recommendPoses({limit: 2}).length, 2);
  assert.equal(recommendPoses({limit: -1}).length, 0);
  assert.equal(recommendPoses({limit: 0}).length, 0);
  assert.equal(recommendPoses({limit: 2.9}).length, 2);
  assert.deepEqual(recommendPoses({scene: 'unknown', shot: 'unknown'}), recommendPoses());
  assert.equal(getPose('unknown'), null);
  assert.equal(renderPoseSvg('<script>'), '');
});

test('required props are explicit and catalog mutation cannot change later recommendations', () => {
  assert.equal(getPose('wall-lean').needsProp, '稳固墙面');
  assert.equal(getPose('cup-hold').needsProp, '杯子');
  assert.ok(!getPose('pocket-rest').needsProp);
  const pose = getPose('easy-angle');
  assert.throws(() => { pose.cues.body = 'changed'; }, TypeError);
  assert.throws(() => { pose.sceneTags.push('unknown'); }, TypeError);
  const results = recommendPoses();
  results.pop();
  assert.equal(POSES.length, 14);
});

test('SVG coordinates use the agreed padded head-to-foot coordinate system', () => {
  assert.equal(POSE_COORDINATES.viewBox, '0 0 200 500');
  assert.equal(POSE_COORDINATES.headTop, 10);
  assert.equal(POSE_COORDINATES.feetY, 480);
  assert.equal(POSE_COORDINATES.bodyHeight, POSE_COORDINATES.feetY - POSE_COORDINATES.headTop);
  assert.deepEqual(POSE_COORDINATES.faceCenter, {x: 100, y: 45});
  assert.equal(POSE_COORDINATES.canonicalFaceY, (45 - 10) / 470);
});

test('every SVG is responsive, accessible, self-contained and inherits the overlay color', () => {
  for (const pose of POSES) {
    const svg = renderPoseSvg(pose.id);
    assert.match(svg, /^<svg .*viewBox="0 0 200 500"/);
    assert.match(svg, /width="100%" height="100%"/);
    assert.match(svg, /role="img" aria-label="/);
    assert.match(svg, /<title>.+姿势参考<\/title>/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /data-part="skeleton"/);
    assert.doesNotMatch(svg, /NaN|Infinity|undefined|<script|<image|<foreignObject|href=|#[0-9a-fA-F]{3,8}/);
    assert.match(svg, /<\/svg>$/);
  }
});

test('templates contain 14 different action geometries rather than changing only labels', () => {
  const geometry = POSES.map(pose => renderPoseSvg(pose.id)
    .replace(/aria-label="[^"]*"/, '')
    .replace(/<title>.*?<\/title>/, ''));
  assert.equal(new Set(geometry).size, 14);
  const frontal = renderPoseSvg('soft-front');
  const profile = renderPoseSvg('far-gaze');
  const angled = renderPoseSvg('three-quarter');
  assert.notEqual(frontal, profile);
  assert.notEqual(frontal, angled);
  assert.match(profile, /data-part="gaze"/); // visible direction cue in a face crop
});

const jointsOf = svg => new Map([...svg.matchAll(/<circle data-joint="([^"]+)" cx="([^"]+)" cy="([^"]+)"/g)]
  .map(([, name, x, y]) => [name, [Number(x), Number(y)]]));
const bonesOf = svg => [...svg.matchAll(/<path d="([^"]+)" data-part="([^"]+)"/g)]
  .map(([, d, name]) => ({name, d, points: [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)]
    .map(([, x, y]) => [Number(x), Number(y)])}));

test('every stick figure has a round head and 13 visible major joints within the shared frame', () => {
  const expected = ['neck', ...['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']
    .flatMap(name => [`${name}-1`, `${name}-2`])].sort();
  for (const pose of POSES) {
    const svg = renderPoseSvg(pose.id), joints = jointsOf(svg);
    assert.match(svg, /<circle data-part="head" cx="100" cy="45" r="35" fill="none"/);
    assert.deepEqual([...joints.keys()].sort(), expected, pose.id);
    for (const [name, [x, y]] of joints) {
      assert.ok(Number.isFinite(x) && x >= 0 && x <= 200, `${pose.id}/${name} x`);
      assert.ok(Number.isFinite(y) && y >= 10 && y <= 480, `${pose.id}/${name} y`);
    }
    assert.equal([...svg.matchAll(/data-joint="[^"]+"[^>]*fill="currentColor"[^>]*stroke="none"/g)].length, 13);
    // The new reference contains no clothing, body silhouette or filled limbs.
    assert.doesNotMatch(svg, /<(?:ellipse|polygon)|<path[^>]*fill="currentColor"/);
  }
});

test('single-line limbs connect the shown joints and at least one foot meets the common baseline', () => {
  for (const pose of POSES) {
    const svg = renderPoseSvg(pose.id), joints = jointsOf(svg), bones = bonesOf(svg);
    for (const [part, names] of [['arm', ['shoulder', 'elbow', 'wrist']], ['leg', ['hip', 'knee', 'ankle']]]) {
      for (const side of [1, 2]) {
        const bone = bones.find(entry => entry.name === `${part}-${side}`);
        assert.deepEqual(bone.points, names.map(name => joints.get(`${name}-${side}`)), `${pose.id}/${part}-${side}`);
        assert.doesNotMatch(bone.d, /[QCAZ]/); // one open segment chain, not an outline
      }
    }
    const feet = bones.filter(entry => entry.name === 'foot');
    assert.equal(feet.length, 2);
    assert.ok(feet.some(foot => foot.points.at(-1)[1] === 480), pose.id);
  }
});

test('face-crop gestures retain a visible wrist, while near-crop gestures remain above the chest cut', () => {
  for (const id of ['chin-rest', 'temple-touch']) {
    const wrists = [...jointsOf(renderPoseSvg(id))].filter(([name]) => name.startsWith('wrist'));
    assert.ok(wrists.some(([, [, y]]) => y <= 80), `${id} detail wrist`);
  }
  for (const id of ['collar-touch', 'cup-hold']) {
    const wrists = [...jointsOf(renderPoseSvg(id))].filter(([name]) => name.startsWith('wrist'));
    assert.ok(wrists.every(([, [, y]]) => y <= 146), `${id} close wrists`);
  }
  assert.match(renderPoseSvg('cup-hold'), /data-part="prop"/);
  assert.match(renderPoseSvg('wall-lean'), /data-part="prop"/);
});

test('mirroring applies one outer transform and leaves all instruction metadata intact', () => {
  for (const pose of POSES) {
    const before = JSON.stringify(pose);
    const normal = renderPoseSvg(pose.id);
    const mirrored = renderPoseSvg(pose.id, {mirror: true});
    assert.equal(mirrored, normal.replace('<g fill="none"', '<g transform="translate(200 0) scale(-1 1)" fill="none"'));
    assert.equal(JSON.stringify(pose), before);
  }
});
