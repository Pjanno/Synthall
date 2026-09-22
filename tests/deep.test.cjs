'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function worker(onMessage = () => {}) {
  const messages = [], self = {postMessage(message) { messages.push(message); onMessage(message, data => self.onmessage({data})); }};
  const context = {self, module:{exports:{}}, Float32Array, Float64Array, setTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8'), context);
  context.module.exports.spectralWorker();
  return {messages, send:data=>self.onmessage({data})};
}
function model(amplitude=.12, phase=0) {
  return {length:256*80, tracks:[{points:Array.from({length:80},(_,frame)=>({frame, frequency:750, amplitude, phase:2*Math.PI*750*frame*256/48000+phase}))}]};
}
async function render(w, analysis) {
  await w.send({type:'restore',model:analysis}); await w.send({type:'render',percent:100,request:1});
  return w.messages.findLast(m=>m.type==='rendered').samples;
}
test('deep refinement reduces measured error and saved parameters reproduce its audio',async()=>{
  const w=worker(), original=await render(w,model()), initial=model(.07,.15), copy=structuredClone(initial);
  await w.send({type:'restore',model:initial});
  await w.send({type:'refine',samples:original,percent:100,request:2});
  const result=w.messages.findLast(m=>m.type==='deepComplete');
  assert.ok(result, JSON.stringify(w.messages.at(-1)));
  assert.ok(result.summary.finalError < result.summary.initialError*.8, JSON.stringify(result.summary));
  assert.ok(result.samples.every(Number.isFinite)); assert.deepEqual(initial,copy);
  assert.deepEqual(await render(w,structuredClone(result.model)),result.samples);
  assert.equal(result.model.samples,undefined);
});
test('cancel preserves the initial reconstruction when no iteration was accepted',async()=>{
  const w=worker((message,send)=>{if(message.type==='deepProgress')send({type:'cancelDeep'});});
  const baseline=await render(w,model(.07));
  await w.send({type:'refine',samples:new Float32Array(baseline.length),percent:100,request:2});
  const result=w.messages.findLast(m=>m.type==='deepComplete');
  assert.ok(result.summary.cancelled); assert.equal(result.summary.accepted,0); assert.deepEqual(result.samples,baseline);
});
test('an already exact reconstruction remains unchanged',async()=>{
  const w=worker(), baseline=await render(w,model());
  await w.send({type:'refine',samples:baseline.slice(),percent:100,request:2});
  const result=w.messages.findLast(m=>m.type==='deepComplete');
  assert.equal(result.summary.initialError,0); assert.equal(result.summary.finalError,0); assert.deepEqual(result.samples,baseline);
});
test('replacing the active model discards an unfinished deep analysis',async()=>{
  const replacement=model(.2), w=worker((message,send)=>{if(message.type==='deepProgress')send({type:'restore',model:replacement});});
  const baseline=await render(w,model());
  await w.send({type:'refine',samples:baseline,percent:100,request:2});
  assert.equal(w.messages.some(m=>m.type==='deepComplete'),false);
  await w.send({type:'snapshot',request:3}); assert.equal(w.messages.at(-1).model,replacement);
});

test('pre-generated notes change pitch while preserving length and temporal envelope',async()=>{
 const w=worker();await w.send({type:'restore',model:model()});
 const outputs=[];
 for(const note of [36,48,60]){
  await w.send({type:'note',note,root:48,percent:100,request:note});
  const result=w.messages.findLast(m=>m.type==='note');assert.equal(result.samples.length,256*80);
  let crossings=0;for(let i=2001;i<18000;i++)if(result.samples[i-1]<=0&&result.samples[i]>0)crossings++;
  outputs.push(crossings);
 }
 assert.ok(Math.abs(outputs[1]/outputs[0]-2)<.03);assert.ok(Math.abs(outputs[2]/outputs[1]-2)<.03);
});
test('automatic preparation refines without an extra user command and works without original audio',async()=>{
 const w=worker(),reference=await render(w,model());await w.send({type:'restore',model:model(.07)});
 await w.send({type:'prepare',samples:reference,percent:100,request:2});
 const refined=w.messages.findLast(m=>m.type==='deepComplete');assert.ok(refined.summary.improvement>0);
 await w.send({type:'restore',model:refined.model});await w.send({type:'prepare',percent:100,request:3});
 const restored=w.messages.findLast(m=>m.type==='deepComplete');assert.equal(restored.request,3);assert.equal(restored.samples.length,reference.length);
});

test('parallel adjustment batches produce the same refinement as sequential execution',async()=>{
 const sourceModel=model(.08,.1);sourceModel.tracks=Array.from({length:4},(_,i)=>({points:sourceModel.tracks[0].points.map(p=>({...p,frequency:p.frequency*(i+1),phase:p.phase*(i+1),amplitude:p.amplitude/(i+1)}))}));
 const target=structuredClone(sourceModel);for(const t of target.tracks)for(const p of t.points)p.amplitude*=1.3;
 const sequential=worker(),reference=await render(sequential,target);await sequential.send({type:'restore',model:structuredClone(sourceModel)});
 await sequential.send({type:'prepare',samples:reference,percent:100,request:2,parallelism:1});
 let batches=0;
 const parallel=worker(async(message,send)=>{
  if(message.type!=='adjustRequest')return;batches++;assert.equal(message.parallelism,14);
  const groups=[[],[],[]];message.entries.forEach((entry,i)=>groups[i%3].push(entry));
  const parts=await Promise.all(groups.map(async entries=>{const helper=worker();await helper.send({type:'adjustBatch',entries,residuals:message.residuals,pass:message.pass,deadline:message.deadline});return helper.messages.at(-1);}));
  await send({type:'adjustReply',request:message.request,pass:message.pass,entries:parts.flatMap(p=>p.entries),aborted:parts.some(p=>p.aborted)});
 });
 await parallel.send({type:'restore',model:structuredClone(sourceModel)});await parallel.send({type:'prepare',samples:reference,percent:100,request:2,parallelism:14});
 const a=sequential.messages.findLast(m=>m.type==='deepComplete'),b=parallel.messages.findLast(m=>m.type==='deepComplete');
 assert.ok(batches>0);assert.deepEqual(b.samples,a.samples);assert.equal(b.summary.finalError,a.summary.finalError);
});
