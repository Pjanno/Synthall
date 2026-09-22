'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function harness(logicalProcessors=8,parallelAdjust=false){
  const elements=new Map(),gainEvents=[],workers=[];let peakWorkers=0;
  class Element{
    constructor(){this.value='';this.textContent='';this.hidden=false;this.children=[];this.dataset={};this.style={};this.classList={add(){},remove(){},toggle(){},contains(){return false;}};}
    append(...children){this.children.push(...children);} add(child){this.append(child);} replaceChildren(){this.children=[];}
    setAttribute(){} addEventListener(){} getAnimations(){return [];} getBoundingClientRect(){return {width:0,height:0};}
    showModal(){this.open=true;} close(){this.open=false;} select(){} focus(){} setCustomValidity(){} reportValidity(){}
  }
  const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  class Audio{
    constructor(){this.currentTime=0;} async resume(){}
    createBuffer(channels,length){const data=new Float32Array(length);return {length,getChannelData:()=>data,copyToChannel:src=>data.set(src)};}
    createGain(){return {gain:{value:0,cancelScheduledValues(time){gainEvents.push(["cancel",time]);},setTargetAtTime(){},setValueAtTime(value,time){gainEvents.push(["set",value,time]);},linearRampToValueAtTime(value,time){gainEvents.push(["ramp",value,time]);}},connect(){},disconnect(){}};}
    createBufferSource(){return {playbackRate:{value:1},connect(){},disconnect(){},start(){},stop(){}};}
    createDynamicsCompressor(){return {threshold:{},knee:{},ratio:{},attack:{},release:{},connect(){}};}
  }
  class Worker{
    constructor(){workers.push(this);peakWorkers=Math.max(peakWorkers,workers.filter(w=>!w.closed).length);}
    terminate(){this.closed=true;}
    postMessage(message){
      message=context.module.exports.parameterMessage(message,false);
      if(message.type==='restore')this.model=message.model;
      if(message.type==='prepare' && parallelAdjust){this.preparing=message;queueMicrotask(()=>{if(!this.closed)this.onmessage({data:{type:'adjustRequest',request:message.request,pass:0,entries:Array.from({length:6},(_,index)=>({index,track:{points:Array.from({length:80},()=>({frame:0,frequency:130,amplitude:.1,phase:0}))}})),residuals:new Float64Array(480),deadline:Date.now()+60000}});});return;}
      if(message.type==='adjustBatch'){queueMicrotask(()=>{if(!this.closed)this.onmessage({data:control.failWorker?{type:'error',message:'test helper failure'}:{type:'adjustResult',entries:message.entries,aborted:false}});});return;}
      if(message.type==='adjustReply'){message={...this.preparing,type:'instrument'};}

      if(['instrument','prepare','note'].includes(message.type))queueMicrotask(()=>{if(!this.closed)this.onmessage({data:{type:message.type==='note'?'note':'deepComplete',request:message.request,note:message.note,model:this.model,summary:{improvement:0},count:Math.max(1,Math.ceil(this.model.tracks.length*(message.percent||100)/100)),gain:1,samples:new Float32Array(480)}});});
    }
  }
  const rows=new Map(),control={fail:false};
  const db={transaction(){const transaction={objectStore:()=>({put:record=>{const copy=structuredClone(record);queueMicrotask(()=>{if(control.fail)transaction.onerror?.();else{rows.set(record.id,copy);transaction.oncomplete?.();}});},delete:id=>queueMicrotask(()=>{if(control.fail)transaction.onerror?.();else{rows.delete(id);transaction.oncomplete?.();}})})};return transaction;}};
  const context={navigator:{hardwareConcurrency:logicalProcessors},document:{getElementById:$,createElement:()=>new Element(),querySelector:()=>$('controls'),querySelectorAll:()=>[],addEventListener(){},activeElement:null},window:{AudioContext:Audio,addEventListener(){}},Worker,ResizeObserver:class{observe(){}},Option:class{},indexedDB:{open(){throw Error('test');}},matchMedia:()=>({matches:true}),Blob,URL,ArrayBuffer,DataView,Float32Array,Float64Array,setTimeout,clearTimeout,cancelAnimationFrame(){},queueMicrotask,module:{exports:{}}};
  let source=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
  source=source.replace('  keyboard(); draw(); openLibrary();',`  globalThis.api={
    seed(db){database=db;ctx=new window.AudioContext();activeId='fixture';sampleName='Renamed draft';sourceName='input-file';activeRoot=48;
      original=ctx.createBuffer(1,480,SR);rawSynth=new Float32Array(480);synthesized=ctx.createBuffer(1,480,SR);
      workerState={length:480,tracks:[{points:[{frame:0,frequency:130,amplitude:.1,phase:0}]}]};
      model={total:1,duration:.01,width:1,height:1,spectrum:new Float32Array([0]),display:[]};
      $('amount').value='67';$('smoothing').value='50';$('selected').textContent='1';
      library.set(activeId,{id:activeId,name:sampleName,root:48,visual:model,original:rawSynth,synthesized:rawSynth});
    },state:()=>({original,rawSynth,synthesized,isSavedInstrument,activeId,records:[...library.values()],bankReady,cacheSize:noteCache.size,adsr,releaseCount:releaseVoices.size,notes:[...noteCache.keys()],voiceIds:[...voices.keys()],pendingCount:pending.size,deepRunning}),selectSample,saveCurrent,
    addRecord:record=>library.set(record.id,record),seedTracks(){workerState={length:480,tracks:Array.from({length:10},(_,i)=>({points:[{frame:0,frequency:130+i,amplitude:.01,phase:0}]}))};model.total=10;},playNote:(note,id)=>play(synthesized,note,id), release,setTime:time=>{ctx.currentTime=time;},stop, deletionId(id){renameId=id;},newSample, seedRefinement(){baseAnalysis=workerState;deepSummary={improvement:25};workerState={...workerState,refined:true};}
  };`);
  vm.runInNewContext(source,context);context.api.seed(db);
  return {api:context.api,$,rows,control,gainEvents,workerStats:()=>({alive:workers.filter(w=>!w.closed).length,peak:peakWorkers})};
}
const {decodeInstrument}=require('../app.js');
const submit=h=>h.$('saveForm').onsubmit({preventDefault(){}});
test('explicit save suggests input name, stores parameters only and releases original buffers',async()=>{
  const h=harness();h.api.saveCurrent();assert.equal(h.rows.size,0);
  h.$('saveInstrument').onclick();assert.equal(h.$('instrumentName').value,'input-file');
  h.$('instrumentName').value='My instrument';await submit(h);
  const record=h.rows.get('fixture');assert.equal(record.kind,'instrument');assert.equal(record.name,'My instrument');
  assert.ok(decodeInstrument(record.parameters).tracks.length);assert.equal(record.analysis,undefined);assert.equal(record.baseAnalysis,undefined);assert.equal(record.version,2);assert.equal(record.original,undefined);assert.equal(record.synthesized,undefined);
  assert.equal(h.api.state().original,null);assert.equal(h.api.state().rawSynth,null);assert.ok(h.api.state().synthesized);
  assert.equal(h.$('comparison').hidden,true);
});
test('failed storage keeps original and comparison available',async()=>{
  const h=harness();h.control.fail=true;h.$('instrumentName').value='Instrument';await submit(h);
  assert.ok(h.api.state().original);assert.ok(h.api.state().rawSynth);assert.equal(h.api.state().isSavedInstrument,false);assert.equal(h.rows.size,0);
});
test('saved instrument reopens from parameters and adjustments never persist audio',async()=>{
  const h=harness();h.$('instrumentName').value='Instrument';await submit(h);h.api.newSample();
  await h.api.selectSample('fixture');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.api.state().original,null);assert.equal(h.api.state().rawSynth,null);assert.ok(h.api.state().synthesized);
  h.api.saveCurrent();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.rows.get('fixture').original,undefined);assert.equal(h.rows.get('fixture').synthesized,undefined);
});
test('deleting active saved sound clears library, storage and playback',async()=>{
  const h=harness();h.$('instrumentName').value='Instrument';await submit(h);h.api.deletionId('fixture');await h.$('deleteOption').onclick();
  assert.equal(h.rows.size,0);assert.equal(h.api.state().records.length,0);assert.equal(h.api.state().activeId,null);assert.equal(h.api.state().synthesized,null);
});


test('saving automatic refinement keeps only final binary parameters without the initial analysis',async()=>{
 const h=harness();h.api.seedRefinement();h.$('instrumentName').value='Automatic';await submit(h);
 const record=h.rows.get('fixture');assert.ok(decodeInstrument(record.parameters).tracks.length);assert.equal(record.analysis,undefined);assert.equal(record.baseAnalysis,undefined);
 assert.equal(record.refinement.improvement,25);assert.equal(record.original,undefined);
});

test('opening an instrument prepares all eighty-eight piano notes',async()=>{
 const h=harness();h.$('instrumentName').value='Bank';await submit(h);h.api.newSample();await h.api.selectSample('fixture');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.api.state().bankReady,true);assert.equal(h.api.state().cacheSize,88);
 h.api.newSample();assert.equal(h.api.state().cacheSize,0);
});

test('saved partial selection remains locked when input events are attempted',async()=>{
 const h=harness();h.$('instrumentName').value='Latest';await submit(h);h.api.newSample();await h.api.selectSample('fixture');
 h.$('amount').value='40';h.$('amount').oninput();h.$('amount').value='90';h.$('amount').oninput();
 await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(h.api.state().bankReady,true);assert.equal(h.api.state().cacheSize,88);assert.equal(h.rows.get('fixture').percent,67);assert.equal(h.$('amount').disabled,true);
});
test('switching away during note preparation discards pending results',async()=>{
 const h=harness();h.$('instrumentName').value='Cancelled';await submit(h);h.api.newSample();await h.api.selectSample('fixture');h.api.newSample();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.api.state().bankReady,false);assert.equal(h.api.state().cacheSize,0);assert.equal(h.api.state().synthesized,null);
});

test('piano bank covers MIDI 21–108 and supports 64 simultaneous voices',async()=>{
 const h=harness();h.$('instrumentName').value='Piano';await submit(h);h.api.newSample();await h.api.selectSample('fixture');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(Array.from(h.api.state().notes),Array.from({length:88},(_,i)=>21+i));
 await Promise.all(Array.from({length:64},(_,i)=>h.api.playNote(21+i,'voice'+i)));
 assert.equal(h.api.state().voiceIds.length,64);assert.equal(h.api.state().voiceIds[0],'voice0');
 await h.api.playNote(108,'extra');assert.equal(h.api.state().voiceIds.length,64);assert.equal(h.api.state().voiceIds.includes('voice0'),false);
 await h.api.playNote(20,'outside-low');await h.api.playNote(109,'outside-high');
 assert.equal(h.api.state().voiceIds.length,64);assert.equal(h.api.state().pendingCount,0);
 for(const id of h.api.state().voiceIds)h.api.release(id);assert.equal(h.api.state().releaseCount,64);
 await Promise.all(Array.from({length:64},(_,i)=>h.api.playNote(21+i,'new'+i)));
 assert.equal(h.api.state().releaseCount,0);assert.equal(h.api.state().voiceIds.length,64);
 h.api.stop();assert.equal(h.api.state().voiceIds.length,0);
});

test('ADSR persists per saved instrument and release starts at the current envelope level',async()=>{
 const h=harness();h.$('instrumentName').value='Envelope';await submit(h);
 assert.equal(h.$('adsrPanel').hidden,false);
 for(const [id,value] of [['adsrAttack','1'],['adsrDecay','2'],['adsrSustain','40'],['adsrRelease','3']]){
  h.$(id).value=value;h.$(id).oninput();h.$(id).onchange();
 }
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.rows.get('fixture').adsr.sustain,.4);
 h.api.newSample();assert.equal(h.$('adsrPanel').hidden,true);await h.api.selectSample('fixture');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.api.state().adsr.attack,1);assert.equal(h.api.state().adsr.release,3);
 await h.api.playNote(60,'held');h.api.setTime(.5);h.api.release('held');
 const peak=100/127*.65;assert.deepEqual(h.gainEvents.slice(-3),[['cancel',.5],['set',peak*.5,.5],['ramp',0,3.5]]);
 assert.equal(h.api.state().releaseCount,1);h.api.stop();assert.equal(h.api.state().releaseCount,0);
});

test('worker count leaves two logical processors aside and all workers end after preparation',async()=>{
 for(const [processors,max] of [[3,1],[4,2],[6,4],[16,14],[128,88]]){
  const h=harness(processors);h.$('instrumentName').value='Pool';await submit(h);h.api.newSample();await h.api.selectSample('fixture');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.api.state().cacheSize,88);
  assert.equal(h.workerStats().alive,0);assert.ok(h.workerStats().peak<=max);assert.equal(h.workerStats().peak,max);
 }
});
test('cancelled preparation terminates every worker',async()=>{
 const h=harness();h.$('instrumentName').value='Cancel pool';await submit(h);h.api.newSample();await h.api.selectSample('fixture');h.api.newSample();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.workerStats().alive,0);assert.equal(h.api.state().cacheSize,0);
});

test('parallel refinement workers are replaced by the note pool and all terminate on completion',async()=>{
 const h=harness(6,true);h.api.seedRefinement();
 h.$('amount').value='70';h.$('amount').oninput();await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(h.api.state().bankReady,true);assert.equal(h.workerStats().alive,0);assert.equal(h.workerStats().peak,4);
});
test('a refinement helper failure terminates the entire pool',async()=>{
 const h=harness(6,true);h.api.seedRefinement();
 h.control.failWorker=true;h.$('amount').value='70';h.$('amount').oninput();await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(h.api.state().bankReady,false);assert.equal(h.api.state().deepRunning,false);assert.equal(h.workerStats().alive,0);
});

test('saving retains only the selected tracks, and reopening never applies the percentage twice',async()=>{
 const h=harness();h.api.seedTracks();h.$('amount').value='50';h.$('instrumentName').value='Half';await submit(h);
 const record=h.rows.get('fixture');assert.equal(decodeInstrument(record.parameters).tracks.length,5);
 assert.equal(record.baseAnalysis,undefined);h.api.newSample();await h.api.selectSample('fixture');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(decodeInstrument(h.rows.get('fixture').parameters).tracks.length,5);assert.equal(h.$('amount').disabled,true);
});
test('legacy saved instruments open and migrate to locked binary storage',async()=>{
 const h=harness();const track={points:[{frame:0,frequency:130,amplitude:.1,phase:0}]};
 h.api.addRecord({id:'legacy',kind:'instrument',version:1,baked:true,name:'Legacy',root:48,percent:50,selected:'1',analysis:{length:480,tracks:[track,track]},baseAnalysis:{length:480,tracks:[track,track]},visual:{total:2,duration:.01,width:1,height:1,spectrum:new Float32Array([0]),display:[]}});
 await h.api.selectSample('legacy');await new Promise(resolve=>setImmediate(resolve));
 const record=h.rows.get('legacy');assert.equal(record.version,2);assert.equal(record.baseAnalysis,undefined);assert.equal(decodeInstrument(record.parameters).tracks.length,1);assert.equal(h.$('amount').disabled,true);
});
