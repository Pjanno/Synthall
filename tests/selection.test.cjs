'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const fn=source.slice(source.indexOf('  async function prepareSelection('),source.indexOf("  $('file').onchange"));
class Offline {
 constructor(channels,length,rate){this.length=length;this.rate=rate;}
 createBuffer(channels,length,rate){const data=new Float32Array(length);return {length,sampleRate:rate,getChannelData:()=>data};}
 createBufferSource(){const owner=this;return {connect(){},start(){owner.input=this.buffer;}};}
 async startRendering(){return {length:this.length,sampleRate:this.rate,input:this.input};}
}
const prepare=vm.runInNewContext(`const SR=48000;${fn};prepareSelection`,{OfflineAudioContext:Offline,Float32Array});
function audio(rate=100,length=4500){const a=Float32Array.from({length},(_,i)=>i/length),b=Float32Array.from(a,v=>v*.5);return {length,sampleRate:rate,numberOfChannels:2,getChannelData:c=>c?b:a};}
test('selection after 15 seconds crops the chosen source frames and averages stereo',async()=>{
 const buffer=audio(),result=await prepare(buffer,30,32.5);
 assert.equal(result.length,120000);assert.equal(result.input.length,250);
 assert.ok(Math.abs(result.input.getChannelData(0)[0]-.5)<1e-7);
 assert.ok(Math.abs(result.input.getChannelData(0)[249]-3249/4500*.75)<1e-7);
});
test('analysis input never exceeds ten seconds even for oversized intervals',async()=>{
 const result=await prepare(audio(),5,40);assert.equal(result.length,480000);assert.equal(result.input.length,1000);
});
test('selection near EOF remains inside the file and supports other sample rates',async()=>{
 const result=await prepare(audio(44100,44100),.995,1.1);
 assert.equal(result.input.length,221);assert.equal(result.length,241);
});
const previewCode=source.slice(source.indexOf('  function stopTrimPreview()'),source.indexOf('  function updateTrim()'));
function previewHarness(deferred=false){
 const button={},started=[],nodes=[];let resume;
 const ready=deferred?new Promise(r=>resume=r):Promise.resolve();
 const head={style:{},hidden:true}, context={button,head,started,nodes,ready,buffer:{duration:45},cancelAnimationFrame(){},requestAnimationFrame(){return 1;}};
 vm.runInNewContext(`let trimPreview=null,trimPreviewTicket=null,importBuffer=buffer,timelinePeaks=[1],busy=false,trimStart=30,trimEnd=32.5;
 let trimPreviewFrame=0,trimPreviewStarted=0,trimPreviewOffset=0,trimPreviewDuration=0,viewStart=25,viewSpan=10;
 const $=id=>id==='trimPlayhead'?head:button,master={},status=()=>{};
 const audio=()=>ready; const ctx={currentTime:0,createBufferSource(){const node={connect(){},disconnect(){this.disconnected=true;},stop(){this.stopped=true;},start(...args){started.push(args);}};nodes.push(node);return node;}};
 function stop(){stopTrimPreview();}
 ${previewCode}
 globalThis.cancel=stopTrimPreview; globalThis.advance=time=>{ctx.currentTime=time;paintTrimPlayhead();};`,context);
 return {button,head,started,nodes,cancel:context.cancel,advance:context.advance,resume};
}
test('preview plays only the chosen offset and duration and resets when finished',async()=>{
 const h=previewHarness();await h.button.onclick();assert.deepEqual(Array.from(h.started[0]),[0,30,2.5]);
 assert.equal(h.button.textContent,'■ Parar trecho');h.nodes[0].onended();assert.equal(h.button.textContent,'▶ Ouvir trecho');
});
test('stopping preview cancels playback even while audio initialization is pending',async()=>{
 const h=previewHarness(true), playing=h.button.onclick();h.cancel();h.resume();await playing;
 assert.equal(h.started.length,0);assert.equal(h.button.textContent,'▶ Ouvir trecho');
});
test('playhead follows audio time within the zoomed timeline and hides on stop',async()=>{
 const h=previewHarness();await h.button.onclick();assert.equal(h.head.style.left,'50%');
 h.advance(1);assert.equal(h.head.style.left,'60%');assert.equal(h.head.hidden,false);
 h.advance(20);assert.equal(h.head.style.left,'75%');
 h.cancel();assert.equal(h.head.hidden,true);
});
