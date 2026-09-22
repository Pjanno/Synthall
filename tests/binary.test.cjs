'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {encodeInstrument,decodeInstrument,spectralWorker}=require('../app.js');
const vm=require('node:vm');
function fixture(){return {length:4096,tracks:Array.from({length:8},(_,index)=>({energy:.23,score:.12,last:{unused:true},points:Array.from({length:16},(_,frame)=>({frame,frequency:220.1234567890123*(index+1),amplitude:.01*Math.exp(-frame/16),phase:2*Math.PI*220.1234567890123*(index+1)*frame*256/48000}))}))};}
test('binary storage retains all synthesis numbers exactly and discards unused tracks and metadata',()=>{
 const model=fixture(),buffer=encodeInstrument(model,4),decoded=decodeInstrument(buffer);
 assert.equal(buffer.byteLength,16+4*(4+16*28));assert.equal(decoded.length,model.length);
 assert.deepEqual(decoded.tracks,model.tracks.slice(0,4).map(({points})=>({points})));
 assert.equal(decoded.tracks[0].energy,undefined);
});
test('invalid, truncated and unsupported binary configurations are rejected',()=>{
 const valid=encodeInstrument(fixture());
 for(const value of [null,new ArrayBuffer(0),valid.slice(0,-1),new ArrayBuffer(16)])assert.throws(()=>decodeInstrument(value),/inválida/);
 const version=valid.slice(0);new DataView(version).setUint32(4,999,true);assert.throws(()=>decodeInstrument(version),/incompatível/);
});
test('binary round trip preserves rendered samples and transposed notes with a frozen selection',async()=>{
 const messages=[],self={postMessage:m=>messages.push(m)};
 vm.runInNewContext('('+spectralWorker.toString()+')();',{self,Float32Array,Float64Array,setTimeout});
 const send=data=>self.onmessage({data}),model=fixture();
 for(const note of [21,48,60,108]){
  await send({type:'restore',model});await send({type:'note',note,root:48,percent:50,request:1});const before=messages.at(-1).samples;
  await send({type:'restore',model:decodeInstrument(encodeInstrument(model,4))});await send({type:'note',note,root:48,percent:100,request:2});assert.deepEqual(messages.at(-1).samples,before);
 }
});
