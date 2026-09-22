'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeAdsr,envelopeLevel}=require('../app.js');
test('ADSR applies attack, decay and sustain including release during attack',()=>{
 const e=normalizeAdsr({attack:1,decay:2,sustain:.4,release:3});
 assert.equal(envelopeLevel(e,-1),0);assert.equal(envelopeLevel(e,.5),.5);
 assert.equal(envelopeLevel(e,1),1);assert.equal(envelopeLevel(e,2),.7);assert.equal(envelopeLevel(e,4),.4);
});
test('zero duration stages and invalid saved settings produce finite bounded envelopes',()=>{
 const e=normalizeAdsr({attack:0,decay:0,sustain:0,release:0});assert.equal(envelopeLevel(e,0),0);
 const restored=normalizeAdsr({attack:-1,decay:Infinity,sustain:9,release:100});
 assert.equal(restored.attack,0);assert.equal(restored.decay,.15);assert.equal(restored.sustain,1);assert.equal(restored.release,10);
 assert.deepEqual(normalizeAdsr(null),normalizeAdsr());
});
