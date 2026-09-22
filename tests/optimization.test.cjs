const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto'),path=require('path');
const test=require('node:test');
const after=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
async function run(source){
 const messages=[],self={postMessage:m=>messages.push(m)};const context={self,module:{exports:{}},Float32Array,Float64Array,setTimeout};vm.runInNewContext(source,context);context.module.exports.spectralWorker();
 const send=data=>self.onmessage({data}),last=type=>messages.findLast(m=>m.type===type),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 const samples=Float32Array.from({length:24000},(_,n)=>{const t=n/48000;return (.2*Math.sin(2*Math.PI*220*t+2*t*t)+.07*Math.cos(2*Math.PI*663*t)+.03*Math.sin(2*Math.PI*1331*t))*Math.min(1,t/.015)*Math.exp(-t*2)});
 const start=performance.now();await send({type:'analyze',samples,root:57});await send({type:'snapshot'});const model=structuredClone(last('snapshot').model),analysis=hash(JSON.stringify(model)),spectrum=hash(Buffer.from(last('analyzed').spectrum.buffer));
 await send({type:'prepare',samples,percent:67,request:1,parallelism:1});const result=last('deepComplete');assert.ok(result);const refineMs=performance.now()-start;
 const notes={};for(const note of [21,48,57,69,108]){await send({type:'note',note,root:57,percent:67,request:2});notes[note]=hash(Buffer.from(last('note').samples.buffer));}
 const summary={...result.summary};delete summary.elapsed;
 return {analysis,spectrum,refined:hash(JSON.stringify(result.model)),audio:hash(Buffer.from(result.samples.buffer)),notes,summary,refineMs};
}
// Golden outputs captured from the pre-optimization implementation in V8.
test('analysis, refinement and transposed notes retain their pre-optimization outputs',async()=>{
 const {refineMs,...actual}=await run(after);
 assert.deepEqual(actual,require('./optimization-golden.json'));
});

test('compact worker messages preserve double precision, metadata and transfer ownership',()=>{
 const {parameterMessage}=require('../app.js');
 const point={frame:3,frequency:440.1234567890123,amplitude:1/7,phase:Math.PI,legacy:'retained'};
 const model={length:100,tracks:[{points:[point],last:point,score:1/3}]};
 const message={type:'adjustBatch',model,entries:[{index:9,track:model.tracks[0]}]},transfers=[];
 const encoded=parameterMessage(message,true,transfers);
 assert.ok(encoded.model.tracks[0].points.packed64 instanceof Float64Array);
 const received=structuredClone(encoded,{transfer:transfers});
 assert.ok(transfers.every(buffer=>buffer.byteLength===0));
 assert.deepEqual(parameterMessage(received,false),message);
 assert.equal(model.tracks[0].points[0].frequency,point.frequency);
});

test('worker budget has no four-worker ceiling and retains its low-core fallback',()=>{
 const {workerBudget}=require('../app.js');
 for(const [reported,expected] of [[undefined,1],[NaN,1],[Infinity,1],[0,1],[1,1],[2,1],[8,6],[16,14],[128,126]]) assert.equal(workerBudget(reported),expected);
});
