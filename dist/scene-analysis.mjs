/**
 * On-device analysis of the already processed, UNSTYLED visible frame.
 * All brightness values are display-referred sRGB luma proxies, not lux,
 * sensor exposure, illuminant colour temperature or scene semantics.
 * Pass the same crop/mirror geometry used by the viewfinder and export.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const LIMITATIONS = Object.freeze([
  '分析的是相机处理后的画面，不能据此测出真实照度、色温或精确 ISO / 快门。',
  '人物明暗来自检测框内的像素，衣服和背景可能影响结果，不是皮肤测光或精确分割。',
  '曝光补偿只是相对当前曝光的尝试建议；高光已丢失时，后期调暗不能恢复细节。',
]);
const CONDITIONS = Object.freeze({
  backlit: {id:'backlit',label:'人物与背景反差大',message:'人物区域明显比背景暗，先留意脸部和亮背景的取舍。'},
  highlights: {id:'highlights',label:'亮部接近溢出',message:'画面中有较多接近纯白的像素，可以尝试保护高光。'},
  low_light: {id:'low_light',label:'画面偏暗',message:'当前画面暗部较多，补光或稳定手机通常比大幅提亮更有帮助。'},
  high_contrast: {id:'high_contrast',label:'明暗反差较大',message:'亮暗区域跨度较大，单一曝光调整可能顾此失彼。'},
  balanced: {id:'balanced',label:'画面明暗较均衡',message:'当前像素没有显示明显的大片高光或暗部问题，可按风格调整。'},
});
const keyOf = key => typeof key==='string' || typeof key==='number' ? String(key) : null;
const invalid = (sourceKey, code, message) => ({
  ok:false,sourceKey:keyOf(sourceKey),code,
  condition:{id:'unavailable',label:'暂无法测光',message},conditions:[],metrics:null,
  recommendation:{ev:null,tips:[message],parameterHints:[]},limitations:[...LIMITATIONS],
});
function clippedBox(box) {
  if (!box || box.visible===false || ![box.x,box.y,box.width,box.height].every(Number.isFinite)
    || box.width<=0 || box.height<=0) return null;
  const x=clamp(box.x,0,1),y=clamp(box.y,0,1);
  const right=clamp(box.x+box.width,0,1),bottom=clamp(box.y+box.height,0,1);
  if(right<=x || bottom<=y) return null;
  const coverage=(right-x)*(bottom-y)/(box.width*box.height);
  if(coverage<.35) return null;
  // Upper part of a person box is only a coarse head/torso proxy. This is not
  // an inferred face ROI. Face boxes use their central area instead.
  const roi=box.kind==='person'
    ? {x:x+(right-x)*.15,y:y+(bottom-y)*.05,width:(right-x)*.70,height:(bottom-y)*.45}
    : {x:x+(right-x)*.10,y:y+(bottom-y)*.10,width:(right-x)*.80,height:(bottom-y)*.80};
  return {x,y,width:right-x,height:bottom-y,coverage,kind:box.kind==='person'?'person':'box',roi};
}
const inside = (x,y,b) => b && x>=b.x && x<b.x+b.width && y>=b.y && y<b.y+b.height;
function percentile(histogram,count,fraction) {
  const threshold=Math.max(1,Math.ceil(count*fraction));
  let seen=0;
  for(let i=0;i<histogram.length;i++) {seen+=histogram[i];if(seen>=threshold)return i/255;}
  return 1;
}
function advice(condition,metrics,intent) {
  let delta=0,reason='当前画面没有明显曝光偏向，可先保持现有曝光。';
  const tips=[];
  if(condition.id==='backlit') {
    if(metrics.highlightRatio<.015 && metrics.clippedChannelRatio<.03) {
      delta=.3;reason='人物区域偏暗且亮部尚有余量，可小幅增加补偿后再次观察。';
    } else reason='人物偏暗而亮背景已接近溢出，单独加曝光容易丢失背景细节。';
    tips.push('先让人物转向光源、换一个拍摄角度或补光，再决定保留人物还是亮背景。');
  } else if(condition.id==='highlights') {
    delta=metrics.highlightRatio>.20 ? -.7 : -.3;
    reason='可尝试降低曝光补偿，观察亮部是否重新出现细节。';
    tips.push('这是拍摄前的补偿建议；已经纯白的照片区域不能靠调暗找回原有细节。');
  } else if(condition.id==='low_light') {
    delta=metrics.highlightRatio<.01 ? .3 : 0;
    reason=delta ? '画面整体偏暗，可小幅加补偿并检查人物与亮部；补偿可能增加噪点或拖影。' : '暗部较多但亮点接近溢出，先保持曝光并改善现场光线。';
    tips.push('优先补光或稳住手机；数字变焦和大幅提亮不能增加原始细节。');
  } else if(condition.id==='high_contrast') {
    reason='亮暗差异较大，先保持曝光，选择要保留的主体明暗。';
    tips.push('靠近柔和光线或调整角度，避免同时要求极暗与极亮区域都有充分细节。');
  }
  const parameterHints=[
    {key:'iso',label:'ISO 参考',value:'自动优先',reason:'没有读取传感器曝光数据，不能从当前预览可靠算出一个正确 ISO。'},
    {key:'whiteBalance',label:'白平衡参考',value:'自动优先',reason:'画面颜色不等于光源色温；暖调风格不修改设备白平衡。'},
  ];
  if(intent==='motion') {
    tips.push('你选择了运动人物：先保证光线与较快快门，避免为了提亮让动作拖影。');
    parameterHints.unshift({key:'shutter',label:'快门起点',value:'手动模式可从 1/250 秒尝试',reason:'仅作运动拍摄起点，需按实际速度、镜头和光线调整；当前分析未测量运动。'});
  } else if(intent==='still') {
    tips.push('你选择了静物：可借助稳定支撑，并留意高光材质是否已经发白。');
    parameterHints.unshift({key:'shutter',label:'快门参考',value:'自动；暗处优先稳定支撑',reason:'没有镜头防抖、焦距和手持稳定性数据，不自动推断安全快门。'});
  } else {
    tips.push('你选择了人像：以脸部看起来是否自然为准，检测框测光可能受到深色衣服影响。');
    parameterHints.unshift({key:'shutter',label:'快门参考',value:'自动优先，留意人物轻微移动',reason:'没有实际运动与防抖数据，固定快门值不能保证清晰。'});
  }
  return {ev:{delta,reason,advisoryOnly:true,basis:'processed-frame-relative-advice'},tips,parameterHints};
}

/** subjectBox must be normalized to this exact visible frame, after mirroring. */
export function analyzeScene({pixels,width,height,subjectBox=null,sourceKey=null,intent='portrait'}={}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2
    ||!Number.isSafeInteger(width*height*4)||!(pixels instanceof Uint8Array||pixels instanceof Uint8ClampedArray)
    ||pixels.length<width*height*4) return invalid(sourceKey,'invalid_image','请先准备可读取的画面。');
  intent=['portrait','still','motion'].includes(intent)?intent:'portrait';
  const step=Math.max(1,Math.ceil(Math.max(width,height)/192));
  const histogram=new Uint32Array(256),box=clippedBox(subjectBox);
  let total=0,count=0,sum=0,shadow=0,highlight=0,clipped=0;
  let subjectCount=0,subjectSum=0,backgroundCount=0,backgroundSum=0;
  let edgeCount=0,edgeSum=0,edgeHits=0,backgroundEdgeCount=0,backgroundEdgeHits=0;
  const luma=i=>(.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2])/255;
  const start=Math.floor(step/2);
  for(let y=start;y<height;y+=step)for(let x=start;x<width;x+=step) {
    total++;const i=(y*width+x)*4;
    if(pixels[i+3]<240)continue;
    const value=luma(i),nx=(x+.5)/width,ny=(y+.5)/height;
    count++;sum+=value;histogram[Math.round(value*255)]++;
    if(value<=.12)shadow++;
    if(value>=.94)highlight++;
    if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>=252)clipped++;
    if(box&&inside(nx,ny,box.roi)){subjectCount++;subjectSum+=value;}
    if(!box||!inside(nx,ny,box)){backgroundCount++;backgroundSum+=value;}
    const rightX=x+step,bottomY=y+step;
    if(rightX<width&&bottomY<height) {
      const ri=(y*width+rightX)*4,bi=(bottomY*width+x)*4;
      if(pixels[ri+3]>=240&&pixels[bi+3]>=240) {
        const edge=(Math.abs(value-luma(ri))+Math.abs(value-luma(bi)))/2;
        edgeCount++;edgeSum+=edge;if(edge>.10)edgeHits++;
        if(!box||(!inside(nx,ny,box)&&!inside((rightX+.5)/width,ny,box)&&!inside(nx,(bottomY+.5)/height,box))) {
          backgroundEdgeCount++;if(edge>.10)backgroundEdgeHits++;
        }
      }
    }
  }
  if(count<16||count/total<.75) return invalid(sourceKey,'insufficient_pixels','画面透明或有效像素不足，暂不提供测光建议。');
  const minimumRegionSamples=Math.max(8,Math.ceil(count*.0025));
  const subjectMean=box&&subjectCount>=minimumRegionSamples?subjectSum/subjectCount:null;
  const backgroundMean=backgroundCount>=minimumRegionSamples?backgroundSum/backgroundCount:null;
  const p05=percentile(histogram,count,.05),p50=percentile(histogram,count,.50),p95=percentile(histogram,count,.95);
  const metrics={
    mean:sum/count,p05,p50,p95,contrast:p95-p05,shadowRatio:shadow/count,highlightRatio:highlight/count,
    clippedChannelRatio:clipped/count,subjectMean,backgroundMean,
    backlightDelta:subjectMean!==null&&backgroundMean!==null?backgroundMean-subjectMean:null,
    edgeDensity:edgeCount?edgeHits/edgeCount:0,edgeMean:edgeCount?edgeSum/edgeCount:0,
    backgroundEdgeDensity:backgroundEdgeCount?backgroundEdgeHits/backgroundEdgeCount:null,
    histogram:Array.from(histogram),samples:count,opaqueCoverage:count/total,sampleStep:step,
    subjectSamples:subjectMean===null?0:subjectCount,backgroundSamples:backgroundCount,
    subjectBox:box?{x:box.x,y:box.y,width:box.width,height:box.height,coverage:box.coverage,kind:box.kind}:null,
  };
  const ids=[];
  if(metrics.backlightDelta!==null&&metrics.backlightDelta>.22&&subjectMean<.42&&backgroundMean>.55)ids.push('backlit');
  if(metrics.highlightRatio>=.06)ids.push('highlights');
  if(metrics.mean<.23||metrics.shadowRatio>.52)ids.push('low_light');
  if(metrics.contrast>.72&&metrics.p05<.20&&metrics.p95>.80)ids.push('high_contrast');
  if(!ids.length)ids.push('balanced');
  const conditions=ids.map(id=>({...CONDITIONS[id]})),condition=conditions[0];
  return {ok:true,sourceKey:keyOf(sourceKey),code:'ok',intent,condition,conditions,metrics,
    recommendation:advice(condition,metrics,intent),limitations:[...LIMITATIONS],
    method:'display-luma-histogram-regional-contrast-local-edges'};
}

/**
 * Live-frame guard, not a source of additional observations. Static photographs
 * can use analyzeScene directly. Caller must reset(newKey) before a source or
 * crop change; a different key cannot silently replace the expected source.
 */
export function createSceneStabilizer({minSamples=2,minDurationMs=350,maxAgeMs=1800}={}) {
  if(!Number.isInteger(minSamples)||minSamples<2||!Number.isFinite(minDurationMs)||minDurationMs<0
    ||!Number.isFinite(maxAgeMs)||maxAgeMs<=minDurationMs)throw new RangeError('Invalid scene stability timing');
  let sourceKey=null,latest=null,lastTime=-Infinity,candidate=null,firstTime=0,samples=0,stable=false;
  const ids=new Set();
  function result(now,reason) {
    const expired=Boolean(latest)&&Number.isFinite(now)&&now-lastTime>maxAgeMs;
    return {analysis:expired?null:latest,stable:Boolean(latest)&&stable&&!expired,expired,sourceKey,
      samples:expired?0:samples,reason:reason||(expired?'expired':stable?'stable':'collecting')};
  }
  return {
    reset(key=null) {
      sourceKey=keyOf(key);latest=null;lastTime=-Infinity;candidate=null;firstTime=0;samples=0;stable=false;ids.clear();
      return result(0,'reset');
    },
    update(analysis,{now,observationId}={}) {
      if(!Number.isFinite(now)||now<0)return result(now,'invalid_time');
      const incoming=keyOf(analysis?.sourceKey);
      if(sourceKey!==null&&incoming!==sourceKey)return result(now,'wrong_source');
      if(now<=lastTime)return result(now,'old_observation');
      if(!analysis?.ok||!analysis.condition||!analysis.recommendation) {
        latest=null;lastTime=now;stable=false;candidate=null;samples=0;ids.clear();return result(now,'invalid_analysis');
      }
      if(sourceKey===null)sourceKey=incoming;
      const id=keyOf(observationId);
      if(id===null)return result(now,'missing_observation_id');
      if(ids.has(id))return result(now,'duplicate_observation');
      if(now-lastTime>maxAgeMs){candidate=null;samples=0;stable=false;ids.clear();}
      ids.add(id);if(ids.size>64)ids.delete(ids.values().next().value);
      const next=`${analysis.condition.id}:${analysis.recommendation.ev?.delta??'none'}:${analysis.intent}`;
      if(next!==candidate){candidate=next;firstTime=now;samples=1;stable=false;}else samples++;
      latest=analysis;lastTime=now;
      stable=samples>=minSamples&&now-firstTime>=minDurationMs;
      return result(now);
    },
    get(now) {return result(now);},
  };
}
