import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const bundle = await build({entryPoints:['packages/figma-plugin/src/serialize.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const { serializeSelection, parsePath } = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.figma = {mixed: Symbol(),root:{name:'Regression'},currentPage:{name:'Tests'},loadFontAsync:async()=>{}};
const options={colorMode:'RGB',trimboxFromSlice:true,bleedMm:0,paperFormat:'auto',ppi:300,embedImages:true};
const identity=[[1,0,0],[0,1,0]];
function shape(id,m=identity){return {id,name:id,type:'RECTANGLE',visible:true,locked:false,opacity:1,blendMode:'NORMAL',absoluteTransform:m,width:20,height:10,fills:[],strokes:[],effects:[],topLeftRadius:0,topRightRadius:0,bottomRightRadius:0,bottomLeftRadius:0,fillGeometry:[{data:'M 0 0 L 20 0 L 20 10 L 0 10 Z',windingRule:'NONZERO'}]};}
function frame(children=[],m=identity){return {...shape('Frame',m),type:'FRAME',width:100,height:200,clipsContent:true,children};}
test('90-degree frames keep the size you see and upright children stay upright',async()=>{
 const upright={...shape('Upright',[[1,0,400],[0,1,620]])};
 const turned=shape('Turned',[[0,-1,490],[1,0,620]]);
 const root=frame([upright,turned],[[0,-1,500],[1,0,600]]);
 const {doc}=await serializeSelection([root],options);
 assert.deepEqual(doc.artboards[0].rect,{x:0,y:0,w:200,h:100});
 assert.equal(doc.artboards[0].children[0].type,'rect');
 assert.deepEqual(doc.artboards[0].children[0].rect,{x:100,y:20,w:20,h:10});
 assert.equal(doc.artboards[0].children[1].type,'path');
});
test('sibling masks form separate scopes and preserve intersections',async()=>{
 const a={...shape('Mask A'),isMask:true,maskType:'VECTOR'};
 const b={...shape('Mask B'),isMask:true,maskType:'VECTOR'};
 const {doc}=await serializeSelection([frame([a,shape('A content'),b,shape('B content')])],options);
 const groups=doc.artboards[0].children;
 assert.equal(groups.length,2); assert.equal(groups[0].type,'group');
 assert.equal(groups[0].children[0].name,'A content'); assert.equal(groups[1].children[0].name,'B content');
});
test('a solid clipped to dot geometry is drawn as those dots',async()=>{
 const mask={...shape('clip-path-dot-color'),isMask:true,maskType:'VECTOR'};
 const ink={...shape('Ink'),fills:[{type:'SOLID',color:{r:0,g:0,b:0},opacity:1}]};
 const qr={...shape('Clip path group'),type:'GROUP',children:[mask,ink]};
 const {doc}=await serializeSelection([frame([shape('Background'),qr])],options);
 const dots=doc.artboards[0].children[1].children[0];
 assert.equal(doc.artboards[0].children[0].name,'Background');
 assert.equal(dots.type,'path');
 assert.equal(dots.fills.length,1);
 assert.equal(dots.fills[0].color.r,0);
});
test('a mask over two shapes stays a clip group',async()=>{
 const mask={...shape('Mask'),isMask:true,maskType:'VECTOR'};
 const a={...shape('A'),fills:[{type:'SOLID',color:{r:0,g:0,b:0},opacity:1}]};
 const b={...shape('B'),fills:[{type:'SOLID',color:{r:1,g:0,b:0},opacity:1}]};
 const {doc}=await serializeSelection([frame([mask,a,b])],options);
 assert.equal(doc.artboards[0].children[0].type,'group');
 assert.equal(doc.artboards[0].children[0].children.length,2);
});
test('hidden masks do not hide their siblings',async()=>{
 const {doc}=await serializeSelection([frame([{...shape('Hidden'),visible:false,isMask:true},shape('Visible')])],options);
 assert.equal(doc.artboards[0].children.length,1); assert.equal(doc.artboards[0].children[0].name,'Visible');
});
test('gradient stop alpha excludes paint opacity (applied once by builder)',async()=>{
 const n=shape('Gradient'); n.fills=[{type:'GRADIENT_LINEAR',opacity:.5,gradientTransform:identity,gradientStops:[{position:0,color:{r:0,g:0,b:0,a:.5}},{position:1,color:{r:1,g:1,b:1,a:1}}]}];
 const {doc}=await serializeSelection([frame([n])],options);
 const fill=doc.artboards[0].children[0].fills[0];assert.equal(fill.opacity,.5);assert.equal(fill.stops[0].opacity,.5);
});
test('quadratic curves preserve closing tangent',()=>{
 const result=parsePath('M 0 0 Q 10 20 20 0 L 0 0 Z',(x,y)=>[x,y]);
 assert.equal(result[0].closed,true);assert.equal(result[0].points.length,2);assert.ok(Math.abs(result[0].points[0][4]-20/3)<1e-8);
});
const colorsBundle=await build({entryPoints:['packages/figma-plugin/src/ui/colors.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {applyColors}=await import('data:text/javascript;base64,'+Buffer.from(colorsBundle.outputFiles[0].text).toString('base64'));
test('offline CMYK export retains RGB and named spot intent',()=>{
 const paint={type:'solid',color:{r:1,g:0,b:0},opacity:1,spot:true,swatch:'Spot/Red'};
 const doc={artboards:[{fills:[paint],children:[]}]};
 const out=applyColors(doc,()=>({}));assert.equal(out.artboards[0].fills[0].cmyk,undefined);assert.equal(out.artboards[0].fills[0].spot,true);assert.deepEqual(out.artboards[0].fills[0].color,paint.color);assert.equal(doc.artboards[0].fills[0],paint);
});
let builder=await readFile('packages/ai-panel/jsx/builder.jsx','utf8');
builder=builder.replace('  return {\n    build: function (path)', '  globalThis.testBuilder = {makeClipping: makeClipping};\n  return {\n    build: function (path)');
// Source may use Windows line endings.
builder=builder.replace('  return {\r\n    build: function (path)', '  globalThis.testBuilder = {makeClipping: makeClipping};\r\n  return {\r\n    build: function (path)');
const sandbox={$:{evalFile(){},fileName:'builder.jsx'},File:function(){this.parent={fsName:'.'}},ZOrderMethod:{BRINGTOFRONT:1}};
vm.createContext(sandbox);vm.runInContext(builder,sandbox);
test('clipping sets an explicit mask, empty clipping groups remain harmless',()=>{
 const path={typename:'PathItem',zOrder(){}}; const group={pageItems:[{},path]};
 sandbox.testBuilder.makeClipping(group,path);assert.equal(path.clipping,true);assert.equal(group.clipped,true);
 const empty={pageItems:[path]};sandbox.testBuilder.makeClipping(empty,path);assert.equal(path.clipping,false);assert.equal(empty.clipped,undefined);
 const open={typename:'PathItem',closed:false,zOrder(){}};
 const poisoned={pageItems:[{},open]};
 sandbox.testBuilder.makeClipping(poisoned,open);assert.equal(open.clipping,false);assert.equal(poisoned.clipped,undefined);
 const dotA={typename:'PathItem',closed:true}, dotB={typename:'PathItem',closed:true};
 const compound={typename:'CompoundPathItem',pathItems:[dotA,dotB],zOrder(){}};
 const dots={pageItems:[{},compound]};
 sandbox.testBuilder.makeClipping(dots,compound);assert.equal(dotA.clipping,true);assert.equal(dotB.clipping,true);
});
