/**
 * Original, display-referred photo looks. These are not camera exposure,
 * white-balance control, denoising, HDR or a manufacturer's colour science.
 * The same ordered CSS filter is used by preview and Canvas export.
 * RGBA fallback follows W3C Filter Effects 1 sRGB component/matrix equations:
 * https://www.w3.org/TR/filter-effects-1/#ShorthandEquivalents
 */
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
export const STYLE_CONTROLS=Object.freeze([
  Object.freeze({key:'brightness',label:'画面明暗',min:-40,max:40,step:1,unit:'%'}),
  Object.freeze({key:'contrast',label:'对比',min:-40,max:40,step:1,unit:'%'}),
  Object.freeze({key:'saturation',label:'饱和',min:-100,max:100,step:1,unit:'%'}),
  Object.freeze({key:'warmth',label:'暖调',min:0,max:60,step:1,unit:'%'}),
]);
const preset=(id,name,description,values,monochrome=false)=>Object.freeze({id,name,description,
  settings:Object.freeze({id,brightness:values[0],contrast:values[1],saturation:values[2],warmth:values[3],monochrome})});
export const STYLE_PRESETS=Object.freeze([
  preset('natural','原色','保留当前画面颜色与明暗。',[0,0,0,0]),
  preset('clear','清透','轻提亮度、对比与色彩。',[4,8,8,0]),
  preset('warm','柔暖','较柔和的对比与轻暖色调。',[4,-5,3,14]),
  preset('film','胶片','降低饱和与对比，加入暖色。',[-2,-8,-12,24]),
  preset('mono','黑白','去除色彩，强调明暗关系。',[0,10,0,0],true),
]);
const findPreset=id=>STYLE_PRESETS.find(item=>item.id===id)||STYLE_PRESETS[0];
export function createStyleSettings(id='natural') {return {...findPreset(id).settings};}
export function normalizeStyleSettings(settings={}) {
  const base=createStyleSettings(settings?.id);
  for(const control of STYLE_CONTROLS)if(Number.isFinite(settings?.[control.key]))
    base[control.key]=Math.round(clamp(settings[control.key],control.min,control.max)*100)/100;
  return base;
}
export function isStyleIdentity(settings) {
  const s=normalizeStyleSettings(settings);
  return !s.monochrome&&STYLE_CONTROLS.every(c=>s[c.key]===0);
}
const decimal=value=>String(Number(value.toFixed(4)));
export function styleFilter(settings) {
  const s=normalizeStyleSettings(settings);
  if(isStyleIdentity(s))return 'none';
  return `brightness(${decimal(1+s.brightness/100)}) contrast(${decimal(1+s.contrast/100)}) saturate(${decimal(1+s.saturation/100)}) sepia(${decimal(s.warmth/100)})${s.monochrome?' grayscale(1)':''}`;
}

/** Returns a copy unless explicitly inPlace. Input uses straight RGBA bytes. */
export function applyStylePixels(pixels,settings,{inPlace=false}={}) {
  if(!(pixels instanceof Uint8Array||pixels instanceof Uint8ClampedArray)||pixels.length%4)
    throw new TypeError('Expected complete RGBA byte pixels');
  const output=inPlace?pixels:new Uint8ClampedArray(pixels);
  const s=normalizeStyleSettings(settings);
  if(isStyleIdentity(s))return output;
  const brightness=1+s.brightness/100,contrast=1+s.contrast/100,saturation=1+s.saturation/100,warmth=s.warmth/100;
  for(let i=0;i<output.length;i+=4) {
    if(output[i+3]===0)continue;
    let r=clamp(output[i]/255*brightness,0,1),g=clamp(output[i+1]/255*brightness,0,1),b=clamp(output[i+2]/255*brightness,0,1);
    r=clamp((r-.5)*contrast+.5,0,1);g=clamp((g-.5)*contrast+.5,0,1);b=clamp((b-.5)*contrast+.5,0,1);
    // saturate uses the spec's .213/.715/.072 matrix, not grayscale's coefficients.
    if(saturation!==1) {
      const rr=(.213+.787*saturation)*r+(.715-.715*saturation)*g+(.072-.072*saturation)*b;
      const gg=(.213-.213*saturation)*r+(.715+.285*saturation)*g+(.072-.072*saturation)*b;
      const bb=(.213-.213*saturation)*r+(.715-.715*saturation)*g+(.072+.928*saturation)*b;
      r=clamp(rr,0,1);g=clamp(gg,0,1);b=clamp(bb,0,1);
    }
    if(warmth) {
      const rr=(1-.607*warmth)*r+.769*warmth*g+.189*warmth*b;
      const gg=.349*warmth*r+(1-.314*warmth)*g+.168*warmth*b;
      const bb=.272*warmth*r+.534*warmth*g+(1-.869*warmth)*b;
      r=clamp(rr,0,1);g=clamp(gg,0,1);b=clamp(bb,0,1);
    }
    if(s.monochrome)r=g=b=.2126*r+.7152*g+.0722*b;
    output[i]=Math.round(r*255);output[i+1]=Math.round(g*255);output[i+2]=Math.round(b*255);
  }
  return output;
}

/** A visible suggestion only. This function never changes settings or a camera. */
export function recommendStyle(scene,intent='portrait') {
  if(!scene?.ok||!scene.metrics)return {id:'natural',reason:'暂未取得有效画面分析，先保留原色。'};
  const ids=new Set((scene.conditions||[scene.condition]).map(item=>item?.id));
  if(ids.has('backlit')||ids.has('highlights'))return {id:'natural',reason:'先保留原色观察人物与高光，风格不能恢复已经丢失的亮部细节。'};
  if(ids.has('low_light'))return {id:'natural',reason:'画面偏暗，先改善光线与稳定性，避免靠强烈风格掩盖噪点或拖影。'};
  if(ids.has('high_contrast'))return {id:'film',reason:'较柔和的对比可改变明暗观感；这是风格选择，不是动态范围恢复。'};
  if(intent==='still')return {id:'clear',reason:'静物可以尝试稍清晰的色彩与对比，按实际材质微调。'};
  if(intent==='motion')return {id:'natural',reason:'先观察动作是否清晰，再决定色彩风格。'};
  return {id:'warm',reason:'人像可以尝试轻暖与柔和对比；是否喜欢仍由你选择。'};
}
