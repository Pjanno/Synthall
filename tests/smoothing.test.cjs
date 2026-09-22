'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const SR = 48000, HOP = 256;
function worker(code = source) {
  const messages = [], self = { postMessage: message => messages.push(message) };
  const context = { self, module: { exports: {} }, Float32Array, Float64Array, setTimeout };
  vm.runInNewContext(code, context); context.module.exports.spectralWorker();
  return { messages, send: data => self.onmessage({ data }) };
}
function model(amplitude = i => .12 + .012 * Math.sin(2 * Math.PI * i / 7), count = 150) {
  return { length: count * HOP, tracks: [{ points: Array.from({ length: count }, (_, frame) => ({
    frame, amplitude: amplitude(frame), frequency: 1500, phase: 2 * Math.PI * 1500 * frame * HOP / SR
  })) }] };
}
async function render(w, smoothing, request = 1) {
  await w.send({ type: 'render', percent: 100, smoothing, request });
  const result = w.messages.findLast(m => m.type === 'rendered' && m.request === request);
  assert.ok(result); assert.ok(result.samples.every(Number.isFinite)); return result.samples;
}
function variation(samples) {
  let prior, result = 0;
  for (let frame = 15; frame < 130; frame++) {
    let energy = 0; for (let n = frame * HOP; n < (frame + 1) * HOP; n++) energy += samples[n] ** 2;
    const rms = Math.sqrt(energy / HOP); if (prior !== undefined) result += (rms - prior) ** 2; prior = rms;
  }
  return result;
}
test('0% is a reversible bypass, including saved analysis and old records', async () => {
  const w = worker(), analysis = model(), original = structuredClone(analysis);
  await w.send({ type: 'restore', model: analysis });
  const baseline = await render(w, undefined);
  assert.deepEqual(await render(w, 0, 2), baseline);
  await render(w, 100, 3);
  assert.deepEqual(await render(w, 0, 4), baseline);
  await w.send({ type: 'snapshot', request: 4 });
  assert.deepEqual(w.messages.at(-1).model, original);
});
test('Gaussian smoothing reduces rapid amplitude variation progressively', async () => {
  const w = worker(); await w.send({ type: 'restore', model: model() });
  const dry = variation(await render(w, 0)), medium = variation(await render(w, 50, 2)), wet = variation(await render(w, 100, 3));
  assert.ok(medium < dry * .75, `${medium} vs ${dry}`);
  assert.ok(wet < medium * .1, `${wet} vs ${medium}`);
});
test('first 20 ms of the onset and a later attack stay unchanged', async () => {
  const w = worker(); await w.send({ type: 'restore', model: model(i => (i < 70 ? .04 : .16) + .004 * Math.sin(2 * Math.PI * i / 7)) });
  const dry = await render(w, 0), wet = await render(w, 100, 2);
  assert.deepEqual(wet.slice(0, 960), dry.slice(0, 960));
  assert.deepEqual(wet.slice(70 * HOP, 70 * HOP + 960), dry.slice(70 * HOP, 70 * HOP + 960));
  assert.deepEqual(wet.slice(149 * HOP), dry.slice(149 * HOP));
});
test('constant and very short partials remain stable', async () => {
  for (const count of [1, 2, 3, 150]) {
    const w = worker(); await w.send({ type: 'restore', model: model(() => .1, count) });
    const dry = await render(w, 0), wet = await render(w, 100, 2);
    assert.equal(wet.length, dry.length);
    assert.ok(wet.every((value, i) => Math.abs(value - dry[i]) < 1e-7));
  }
});
test('rapid edits only deliver the latest render', async () => {
  const w = worker(); await w.send({ type: 'restore', model: model() });
  await Promise.all([w.send({ type: 'render', percent: 100, smoothing: 100, request: 1 }), w.send({ type: 'render', percent: 100, smoothing: 20, request: 2 })]);
  assert.deepEqual(w.messages.filter(m => m.type === 'rendered').map(m => m.request), [2]);
});
