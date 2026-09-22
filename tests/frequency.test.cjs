'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
// Exercise the actual worker helper, without adding a test protocol to the app.
const start=source.indexOf('  function smoothFrequencies('),end=source.indexOf('  async function render(',start);
const smooth=vm.runInNewContext(`(()=>{const HOP=256,SR=48000,TAU=2*Math.PI;${source.slice(start,end)}return smoothFrequencies;})()`);
function points(count=180){let phase=0;return Array.from({length:count},(_,i)=>{const frequency=440*2**((8*Math.sin(i*2*Math.PI/7))/1200);if(i)phase+=2*Math.PI*frequency*256/48000;return {frame:i,frequency,amplitude:.1,phase};});}
function variation(p){let v=0;for(let i=20;i<140;i++)v+=(Math.log2(p[i].frequency/p[i-1].frequency)*1200)**2;return v;}
test('frequency smoothing progressively reduces jitter and never mutates the analysis',()=>{const p=points(),copy=structuredClone(p);assert.equal(smooth(p,0),p);const mid=smooth(p,.5),wet=smooth(p,1);assert.ok(variation(mid)<variation(p)*.5);assert.ok(variation(wet)<variation(mid)*.1);assert.deepEqual(p,copy);});
test('large frequency breaks retain both endpoints without averaging across the break',()=>{const p=points();for(let i=90;i<p.length;i++)p[i].frequency*=2**(80/1200);const wet=smooth(p,1);assert.equal(wet[89].frequency,p[89].frequency);assert.equal(wet[90].frequency,p[90].frequency);assert.ok(wet.slice(0,90).every(v=>v.frequency<460));assert.ok(wet.slice(90).every(v=>v.frequency>455));});
test('phase increments follow smoothed frequencies in the interior',()=>{const wet=smooth(points(),1);for(let i=20;i<140;i++){const step=2*Math.PI*(wet[i-1].frequency+wet[i].frequency)*.5*256/48000;assert.ok(Math.abs((wet[i].phase-wet[i-1].phase)-step)<1e-9);}});
test('attacks, short tracks and frame gaps remain separate',()=>{const p=points();p[60].amplitude=.4;for(let i=100;i<p.length;i++)p[i].frame+=3;const wet=smooth(p,1);for(const i of [59,60,99,100])assert.equal(wet[i].frequency,p[i].frequency);const short=points(2);assert.equal(smooth(short,1),short);});
