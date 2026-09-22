'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {samplePeakDb,meterPercent}=require('../app.js');
test('sample peak is calibrated in dBFS',()=>{
  assert.equal(samplePeakDb([0,0]),-Infinity);
  assert.equal(samplePeakDb([-.1,1,.2]),0);
  assert.ok(Math.abs(samplePeakDb([-.5,.1])+6.020599913)<1e-8);
  assert.ok(Math.abs(samplePeakDb([.001])+60)<1e-8);
  assert.ok(samplePeakDb([1.2])>0);
});
test('meter maps -60 to 0 dBFS without overflowing on silence or overload',()=>{
  assert.equal(meterPercent(-Infinity),0);assert.equal(meterPercent(-60),0);
  assert.equal(meterPercent(-30),50);assert.equal(meterPercent(0),100);assert.equal(meterPercent(6),100);
});
