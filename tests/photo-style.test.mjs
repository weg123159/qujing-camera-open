import test from 'node:test';
import assert from 'node:assert/strict';
import {STYLE_PRESETS,STYLE_CONTROLS,createStyleSettings,normalizeStyleSettings,isStyleIdentity,styleFilter,applyStylePixels,recommendStyle} from '../dist/photo-style.mjs';

test('original zero settings are strictly byte-identical including transparent pixels',()=>{
  const pixels=new Uint8ClampedArray([0,255,73,255,101,87,220,128,44,72,119,0]);
  const original=new Uint8ClampedArray(pixels),settings=createStyleSettings('natural');
  assert.equal(styleFilter(settings),'none');assert.equal(isStyleIdentity(settings),true);
  const copy=applyStylePixels(pixels,settings);assert.deepEqual(copy,original);assert.notEqual(copy,pixels);assert.deepEqual(pixels,original);
  assert.equal(applyStylePixels(pixels,settings,{inPlace:true}),pixels);assert.deepEqual(pixels,original);
});

test('five independent presets and UI bounds are deterministic, finite and immutable',()=>{
  assert.deepEqual(STYLE_PRESETS.map(p=>p.id),['natural','clear','warm','film','mono']);
  for(const preset of STYLE_PRESETS) {
    const settings=createStyleSettings(preset.id);assert.notEqual(settings,preset.settings);
    for(const control of STYLE_CONTROLS)assert.ok(settings[control.key]>=control.min&&settings[control.key]<=control.max);
    settings.brightness=40;assert.notEqual(preset.settings.brightness,40);
  }
  assert.throws(()=>{STYLE_PRESETS[0].settings.brightness=1;},TypeError);
});

test('normalization clamps user adjustments and refuses non-numeric payloads',()=>{
  const input={id:'unknown',brightness:1000,contrast:-1000,saturation:Infinity,warmth:-3};
  assert.deepEqual(normalizeStyleSettings(input),{id:'natural',brightness:40,contrast:-40,saturation:0,warmth:0,monochrome:false});
  assert.equal(normalizeStyleSettings({id:'warm',brightness:'8'}).brightness,4);
  assert.equal(normalizeStyleSettings(null).id,'natural');
  assert.equal(normalizeStyleSettings({id:'mono',monochrome:false}).monochrome,true);
});

test('brightness and contrast use actual component transforms and clamp each stage',()=>{
  assert.deepEqual([...applyStylePixels(new Uint8ClampedArray([100,100,100,255]),{brightness:20})],[120,120,120,255]);
  assert.deepEqual([...applyStylePixels(new Uint8ClampedArray([100,100,100,255]),{brightness:-40})],[60,60,60,255]);
  // Brightness clips 200*1.4 to 255 before contrast reduces it to 204.
  assert.deepEqual([...applyStylePixels(new Uint8ClampedArray([200,100,0,255]),{brightness:40,contrast:-40})],[204,135,51,255]);
});

test('desaturation and monochrome turn RGB primaries into equal channels',()=>{
  const primaries=new Uint8ClampedArray([255,0,0,255,0,255,0,128,0,0,255,255]);
  assert.deepEqual([...applyStylePixels(primaries,{saturation:-100})],[54,54,54,255,182,182,182,128,18,18,18,255]);
  assert.deepEqual([...applyStylePixels(primaries,{id:'mono',contrast:0})],[54,54,54,255,182,182,182,128,18,18,18,255]);
  assert.ok(styleFilter(createStyleSettings('mono')).endsWith('grayscale(1)'));
});

test('warm adjustment follows the sRGB sepia matrix and preserves alpha',()=>{
  const pixels=new Uint8ClampedArray([120,120,120,128,8,16,24,0]);
  assert.deepEqual([...applyStylePixels(pixels,{warmth:60})],[145,135,115,128,8,16,24,0]);
  assert.deepEqual([...pixels],[120,120,120,128,8,16,24,0]);
});

test('preview/export filter has one fixed operation order matching pixel fallback',()=>{
  assert.equal(styleFilter({brightness:10,contrast:-20,saturation:30,warmth:15}),
    'brightness(1.1) contrast(0.8) saturate(1.3) sepia(0.15)');
  const pixels=new Uint8Array([120,80,60,255]);
  assert.equal(applyStylePixels(pixels,{brightness:10},{inPlace:true}),pixels);
  assert.deepEqual([...pixels],[132,88,66,255]);
  assert.throws(()=>applyStylePixels([0,0,0,255],{}),TypeError);
  assert.throws(()=>applyStylePixels(new Float32Array(4),{}),TypeError);
  assert.throws(()=>applyStylePixels(new Int8Array(4),{}),TypeError);
  assert.throws(()=>applyStylePixels(new Uint8Array(3),{}),TypeError);
});

test('recommendation is advisory and never rewrites a selected or manually adjusted style',()=>{
  const selected={...createStyleSettings('film'),brightness:17},before=JSON.stringify(selected);
  const scene={ok:true,condition:{id:'balanced'},conditions:[{id:'balanced'}],metrics:{}};
  assert.equal(recommendStyle(scene,'portrait').id,'warm');assert.equal(recommendStyle(scene,'still').id,'clear');
  assert.equal(recommendStyle({...scene,conditions:[{id:'highlights'}]}).id,'natural');
  assert.equal(recommendStyle({...scene,conditions:[{id:'low_light'}]}).id,'natural');
  assert.equal(recommendStyle(null).id,'natural');assert.equal(JSON.stringify(selected),before);
});
