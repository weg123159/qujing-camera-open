import test from 'node:test';
import assert from 'node:assert/strict';
import { getCoverCrop, sourcePointToView, sourceBoxToView } from '../dist/guide.mjs';
import { getZoomCrop, pointToCropView } from '../dist/zoom-geometry.mjs';

const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} should equal ${expected}`);

test('2x live portrait crop divides both source dimensions and keeps the selected aspect',()=>{
 const crop=getZoomCrop(1920,1440,.75,2);
 assert.deepEqual(crop,{sx:690,sy:360,sw:540,sh:720});
 assert.equal(crop.sw/crop.sh,.75);
 assert.deepEqual(pointToCropView({x:.5,y:.75},1920,1440,crop),{x:.5,y:1,visible:true});
});

test('portrait source with landscape output also crops and zooms around the true source centre',()=>{
 assert.deepEqual(getZoomCrop(1080,1920,4/3,2),{sx:270,sy:757.5,sw:540,sh:405});
});

test('1x crop exactly preserves the existing cover geometry for every supported frame aspect',()=>{
 for(const [w,h] of [[1920,1440],[1080,1920],[1200,800]])for(const aspect of [.75,1,4/3]){
  assert.deepEqual(getZoomCrop(w,h,aspect,1),getCoverCrop(w,h,aspect,1));
 }
});

test('normalized overlay points match centred CSS zoom and mirror across source orientations',()=>{
 for(const [w,h] of [[1920,1440],[1080,1920],[1200,800]])for(const aspect of [.75,1,4/3])for(const z of [1,1.5,2,6])for(const mirrored of [false,true]){
  const crop=getZoomCrop(w,h,aspect,z);
  for(const point of [{x:.5,y:.5},{x:.53,y:.45},{x:.1,y:.9}]){
   const base=sourcePointToView(point,w,h,aspect,1,false);
   const cssX=.5+(base.x-.5)*z,cssY=.5+(base.y-.5)*z;
   const actual=pointToCropView(point,w,h,crop,mirrored);
   near(actual.x,mirrored?1-cssX:cssX);near(actual.y,cssY);
   assert.equal(actual.visible,actual.x>=0&&actual.x<=1&&actual.y>=0&&actual.y<=1);
  }
 }
});

test('person foot point and face centre remain consistent with the exact transformed detection box',()=>{
 for(const mirrored of [false,true]){
  const box={x:.43,y:.35,width:.12,height:.24};
  const crop=getZoomCrop(1920,1440,.75,3);
  const result=sourceBoxToView(box,1920,1440,.75,1,mirrored,crop);
  const foot=pointToCropView({x:box.x+box.width/2,y:box.y+box.height},1920,1440,crop,mirrored);
  const face=pointToCropView({x:box.x+box.width/2,y:box.y+box.height/2},1920,1440,crop,mirrored);
  near(foot.x,result.x+result.width/2);near(foot.y,result.y+result.height);
  near(face.x,result.x+result.width/2);near(face.y,result.y+result.height/2);
 }
});

test('export crop and planner crop retain aspect and scale equally with larger digital magnification',()=>{
 for(const aspect of [.75,1,4/3])for(const zoom of [1,2,3,6]){
  const base=getCoverCrop(3840,2160,aspect,1),crop=getZoomCrop(3840,2160,aspect,zoom);
  near(crop.sw/crop.sh,aspect);near(crop.sw,base.sw/zoom);near(crop.sh,base.sh/zoom);
  near(crop.sx+crop.sw/2,1920);near(crop.sy+crop.sh/2,1080);
  const exportScale=Math.min(1,2400/Math.max(crop.sw,crop.sh));
  const plannerScale=Math.min(1,640/Math.max(crop.sw,crop.sh));
  near((crop.sw*exportScale)/(crop.sh*exportScale),(crop.sw*plannerScale)/(crop.sh*plannerScale));
 }
});

test('zoomed-out-of-view subjects remain invisible and clipped boxes keep their raw boundary evidence',()=>{
 const crop=getZoomCrop(1920,1440,.75,2);
 const point=pointToCropView({x:.5,y:.9},1920,1440,crop);assert.equal(point.visible,false);assert.ok(point.y>1);
 const box=sourceBoxToView({x:.3,y:.2,width:.4,height:.6},1920,1440,.75,1,false,crop);
 assert.ok(box.x<0);assert.ok(box.y<0);assert.ok(box.y+box.height>1);
});

test('explicit panned-photo crop supports the same point mapping and post-crop mirror',()=>{
 const crop={sx:80,sy:30,sw:240,sh:320},point={x:.2,y:.2};
 const regular=pointToCropView(point,960,640,crop,false),mirrored=pointToCropView(point,960,640,crop,true);
 near(regular.x,112/240);near(regular.y,98/320);near(mirrored.x,1-regular.x);near(mirrored.y,regular.y);
});

test('invalid magnification cannot invent a wider field of view or produce an invalid crop',()=>{
 for(const zoom of [0,.5,NaN,Infinity,-1])assert.throws(()=>getZoomCrop(1920,1440,.75,zoom),RangeError);
 for(const dims of [[0,1440,.75],[1920,0,.75],[1920,1440,0]])assert.throws(()=>getZoomCrop(...dims,2),RangeError);
});

test('invalid points and crops are explicitly invisible',()=>{
 const valid=getZoomCrop(1920,1440,.75,2);
 for(const point of [null,{x:NaN,y:.5},{x:1.1,y:.5}])assert.equal(pointToCropView(point,1920,1440,valid).visible,false);
 for(const crop of [null,{sx:0,sy:0,sw:0,sh:1},{sx:0,sy:Infinity,sw:1,sh:1}])assert.equal(pointToCropView({x:.5,y:.5},1920,1440,crop).visible,false);
 assert.equal(pointToCropView({x:.5,y:.5},0,1440,valid).visible,false);
});
