/* Spectral Resynth — standalone, dependency-free prototype.
 * Analysis and synthesis run in a Worker built from this same file.
 * No network requests, libraries, or external assets are required.
 */
'use strict';

// Compact only the worker wire format; saved instruments keep their existing schema.
function parameterMessage(message, encode, transfers = []) {
  const track = source => {
    if (!source) return source;
    if (!encode) {
      if (!source.points?.packed64) return source;
      const { packed64, extras } = source.points, points = [];
      for (let i = 0; i < packed64.length; i += 4) points.push({ ...extras?.[i / 4], frame: packed64[i], frequency: packed64[i + 1], amplitude: packed64[i + 2], phase: packed64[i + 3] });
      return { ...source, points };
    }
    if (!Array.isArray(source.points)) return source;
    const packed64 = new Float64Array(source.points.length * 4);
    let extras;
    source.points.forEach((point, i) => {
      const offset = i * 4;
      packed64[offset] = point.frame; packed64[offset + 1] = point.frequency;
      packed64[offset + 2] = point.amplitude; packed64[offset + 3] = point.phase;
      for (const key of Object.keys(point)) {
        if (key === 'frame' || key === 'frequency' || key === 'amplitude' || key === 'phase') continue;
        extras ||= []; extras[i] ||= {}; extras[i][key] = point[key];
      }
    });
    transfers.push(packed64.buffer);
    return { ...source, points: { packed64, extras } };
  };
  return { ...message,
    ...(message.model ? { model: { ...message.model, tracks: message.model.tracks.map(track) } } : {}),
    ...(message.entries ? { entries: message.entries.map(entry => ({ ...entry, track: track(entry.track) })) } : {})
  };
}

// Versioned little-endian storage: header, point counts, then frame + three Float64 values.
function encodeInstrument(model, count = model.tracks.length) {
  const tracks = model.tracks.slice(0, count);
  const bytes = 16 + tracks.reduce((sum, track) => sum + 4 + track.points.length * 28, 0);
  const buffer = new ArrayBuffer(bytes), view = new DataView(buffer);
  view.setUint32(0, 0x53594e32, true); view.setUint32(4, 1, true);
  view.setUint32(8, model.length, true); view.setUint32(12, tracks.length, true);
  let offset = 16;
  for (const track of tracks) {
    view.setUint32(offset, track.points.length, true); offset += 4;
    for (const point of track.points) {
      view.setUint32(offset, point.frame, true);
      view.setFloat64(offset + 4, point.frequency, true); view.setFloat64(offset + 12, point.amplitude, true); view.setFloat64(offset + 20, point.phase, true);
      offset += 28;
    }
  }
  return buffer;
}
function decodeInstrument(buffer) {
  const invalid = () => { throw new Error('Configuração de instrumento inválida ou incompatível.'); };
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) return invalid();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x53594e32 || view.getUint32(4, true) !== 1) return invalid();
  const length = view.getUint32(8, true), count = view.getUint32(12, true), tracks = [];
  if (!length || length > 48000 * 15 || count > (buffer.byteLength - 16) / 4) return invalid();
  let offset = 16;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > buffer.byteLength) return invalid();
    const size = view.getUint32(offset, true), points = []; offset += 4;
    if (size > (buffer.byteLength - offset) / 28) return invalid();
    for (let i = 0; i < size; i++) {
      const point = { frame: view.getUint32(offset, true), frequency: view.getFloat64(offset + 4, true), amplitude: view.getFloat64(offset + 12, true), phase: view.getFloat64(offset + 20, true) };
      if (!Number.isFinite(point.frequency) || !Number.isFinite(point.amplitude) || !Number.isFinite(point.phase) || point.frame > Math.ceil(length / 256) + 1 || (i && point.frame <= points[i - 1].frame)) return invalid();
      points.push(point); offset += 28;
    }
    tracks.push({ points });
  }
  if (offset !== buffer.byteLength) return invalid();
  return { length, tracks };
}

function spectralWorker() {
  const N = 4096, HOP = 256, SR = 48000, TAU = 2 * Math.PI;
  let model = null, revision = 0, cancelDeep = false, parallelism = 1, adjustment = null;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const report = (text, value) => self.postMessage({ type: 'progress', text, value });
  const fftPlans = new Map();
  const adjustmentWindow = Float64Array.from({ length: HOP * 2 }, (_, i) => .5 + .5 * Math.cos(Math.PI * (i - HOP) / HOP));
  function checkpoint() {
    let next = 0;
    return async () => { if (Date.now() >= next) { await pause(); next = Date.now() + 8; } };
  }
  function fft(real, imag) {
    const n = real.length;
    let plan = fftPlans.get(n);
    if (!plan) {
      const swaps = [], stages = [];
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) swaps.push(i, j);
      }
      for (let size = 2; size <= n; size *= 2) {
        const angle = -TAU / size, wr = Math.cos(angle), wi = Math.sin(angle);
        const re = new Float64Array(size / 2), im = new Float64Array(size / 2);
        let ur = 1, ui = 0;
        for (let j = 0; j < size / 2; j++) {
          re[j] = ur; im[j] = ui;
          const next = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = next;
        }
        stages.push({ size, re, im });
      }
      plan = { swaps, stages }; fftPlans.set(n, plan);
    }
    for (let k = 0; k < plan.swaps.length; k += 2) {
      const i = plan.swaps[k], j = plan.swaps[k + 1];
      [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    for (const { size, re, im } of plan.stages) {
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < size / 2; j++) {
          const a = start + j, b = a + size / 2, ur = re[j], ui = im[j];
          const tr = ur * real[b] - ui * imag[b], ti = ur * imag[b] + ui * real[b];
          real[b] = real[a] - tr; imag[b] = imag[a] - ti;
          real[a] += tr; imag[a] += ti;
        }
      }
    }
  }
  async function analyze(samples, root, token) {
    const yieldIfNeeded = checkpoint();
    if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length > SR * 15) throw new Error('Amostra inválida ou acima de 15 segundos.');
    const frames = Math.ceil(samples.length / HOP) + 1;
    const win = Float64Array.from({ length: N }, (_, i) => .5 - .5 * Math.cos(TAU * i / N));
    const real = new Float64Array(N), imag = new Float64Array(N), mags = new Float64Array(N / 2 + 1);
    const width = Math.min(frames, 800), height = 256, spectrum = new Float32Array(width * height);
    spectrum.fill(-100);
    const yBins = Array.from({ length: height }, (_, y) => {
      const high = 20000 * Math.pow(20 / 20000, y / height), low = 20000 * Math.pow(20 / 20000, (y + 1) / height);
      return [Math.max(1, Math.floor(low * N / SR)), Math.min(N / 2, Math.ceil(high * N / SR))];
    });
    const tracks = []; let previous = [];
    for (let frame = 0; frame < frames; frame++) {
      const center = frame * HOP;
      for (let i = 0; i < N; i++) { real[i] = (samples[center + i - N / 2] || 0) * win[i]; imag[i] = 0; }
      fft(real, imag);
      let maximum = 0;
      for (let k = 0; k <= N / 2; k++) { mags[k] = Math.hypot(real[k], imag[k]) * 4 / N; maximum = Math.max(maximum, mags[k]); }
      const x = Math.min(width - 1, Math.floor(frame * width / frames));
      for (let y = 0; y < height; y++) {
        let magnitude = 1e-5;
        for (let k = yBins[y][0]; k <= yBins[y][1]; k++) magnitude = Math.max(magnitude, mags[k]);
        const index = y * width + x;
        spectrum[index] = Math.max(spectrum[index], 20 * Math.log10(magnitude));
      }
      const peaks = [], threshold = Math.max(1e-5, maximum * Math.pow(10, -65 / 20));
      for (let k = 2; k < N / 2 - 1; k++) {
        if (mags[k] < threshold || mags[k] <= mags[k - 1] || mags[k] <= mags[k + 1]) continue;
        const a = Math.log(Math.max(1e-15, mags[k - 1])), b = Math.log(mags[k]), c = Math.log(Math.max(1e-15, mags[k + 1]));
        const delta = Math.max(-.5, Math.min(.5, .5 * (a - c) / (a - 2 * b + c)));
        const frequency = (k + delta) * SR / N;
        // Correct FFT phase to the center of the symmetric analysis window.
        const phase = Math.atan2(imag[k], real[k]) + Math.PI * k;
        peaks.push({ frame, frequency, amplitude: Math.exp(b - .25 * (a - c) * delta), phase });
      }
      peaks.sort((a, b) => b.amplitude - a.amplitude);
      previous.sort((a, b) => a.last.frequency - b.last.frequency);
      const used = new Set(), current = [];
      for (const p of peaks) {
        const tolerance = Math.max(SR / N * 1.5, p.frequency * .025);
        let low = 0, high = previous.length;
        while (low < high) { const mid = (low + high) >> 1; if (previous[mid].last.frequency < p.frequency - tolerance) low = mid + 1; else high = mid; }
        let best = null, distance = Infinity;
        for (let j = low; j < previous.length && previous[j].last.frequency <= p.frequency + tolerance; j++) {
          const t = previous[j], d = Math.abs(t.last.frequency - p.frequency);
          if (!used.has(t) && d < distance) { best = t; distance = d; }
        }
        if (!best) { best = { points: [], energy: 0, weighted: 0 }; tracks.push(best); }
        used.add(best); best.points.push(p); best.last = p;
        best.energy += p.amplitude * p.amplitude;
        best.weighted += p.frequency * p.amplitude * p.amplitude;
        current.push(best);
      }
      previous = current;
      if (frame % 32 === 0) { report('Analisando picos e trajetórias…', frame / frames * 100); await yieldIfNeeded(); if (token !== revision) return; }
    }
    const fundamental = 440 * Math.pow(2, (root - 69) / 12);
    const valid = tracks.filter(t => t.points.length >= 3 && t.energy > 1e-9);
    for (const t of valid) {
      const ratio = t.weighted / t.energy / fundamental;
      const harmonic = Math.max(1, Math.round(ratio));
      t.score = t.energy * (1 + .08 * Math.exp(-Math.pow((ratio - harmonic) / .08, 2)));
    }
    valid.sort((a, b) => b.score - a.score);
    if (token !== revision) return;
    model = { tracks: valid, length: samples.length };
    const display = valid.slice(0, 80).map(t => t.points.filter((_, i) => i % 3 === 0).map(p => [p.frame * HOP / SR, p.frequency]));
    self.postMessage({ type: 'analyzed', total: valid.length, width, height, spectrum, display, duration: samples.length / SR }, [spectrum.buffer]);
  }
  function smoothAmplitudes(points, amount) {
    if (!amount || points.length < 3) return points;
    // 100% = sigma of 30 ms, truncated at 3 sigma. Never change the source tracks.
    const dt = HOP / SR, sigma = .030 * amount / dt, radius = Math.ceil(3 * sigma);
    const weights = Float64Array.from({ length: radius + 1 }, (_, k) => Math.exp(-.5 * (k / sigma) ** 2));
    let peak = 0;
    for (const p of points) peak = Math.max(peak, p.amplitude);
    // Do not average across a distinct attack (including later attacks in a track).
    const boundaries = [0];
    for (let i = 1; i < points.length; i++) {
      if (points[i].amplitude > points[i - 1].amplitude * 1.5 && points[i].amplitude - points[i - 1].amplitude > peak * .12) boundaries.push(i);
    }
    boundaries.push(points.length);
    const smoothed = new Array(points.length);
    for (let segment = 0; segment < boundaries.length - 1; segment++) {
      const start = boundaries[segment], end = boundaries[segment + 1];
      for (let i = start; i < end; i++) {
        let sum = 0, weight = 0;
        for (let j = Math.max(start, i - radius); j < Math.min(end, i + radius + 1); j++) {
          const w = weights[Math.abs(j - i)]; sum += points[j].amplitude * w; weight += w;
        }
        // Keep the first 20 ms, introduce smoothing over the next 20 ms, and
        // preserve the track's final amplitude for its existing death ramp.
        const protectedFrames = Math.ceil(.020 / dt);
        const attack = Math.max(0, Math.min(1, (i - start - protectedFrames) / protectedFrames));
        const release = Math.min(1, (points.length - 1 - i) * dt / .020);
        const mix = amount * attack * release;
        smoothed[i] = { ...points[i], amplitude: points[i].amplitude + mix * (sum / weight - points[i].amplitude) };
      }
    }
    return smoothed;
  }
  function smoothFrequencies(points, amount) {
    if (!amount || points.length < 3) return points;
    const dt = HOP / SR, sigma = .020 * amount / dt, radius = Math.ceil(3 * sigma);
    const weights = Float64Array.from({ length: radius + 1 }, (_, k) => Math.exp(-.5 * (k / sigma) ** 2));
    const logF = points.map(p => Math.log2(Math.max(1e-9, p.frequency)));
    let peak = 0;
    for (const p of points) peak = Math.max(peak, p.amplitude);
    const edges = [0], mix = new Float64Array(points.length), result = new Array(points.length);
    for (let i = 1; i < points.length; i++) {
      const jump = Math.abs(logF[i] - logF[i - 1]) * 1200 >= 50;
      const attack = points[i].amplitude > points[i - 1].amplitude * 1.5 && points[i].amplitude - points[i - 1].amplitude > peak * .12;
      if (jump || attack || points[i].frame !== points[i - 1].frame + 1) edges.push(i);
    }
    edges.push(points.length);
    for (let segment = 0; segment < edges.length - 1; segment++) {
      const start = edges[segment], end = edges[segment + 1];
      for (let i = start; i < end; i++) {
        let sum = 0, weight = 0;
        for (let j = Math.max(start, i - radius); j < Math.min(end, i + radius + 1); j++) {
          const w = weights[Math.abs(i - j)]; sum += logF[j] * w; weight += w;
        }
        // Keep both sides of every break unchanged; fade the effect in/out over 20 ms.
        mix[i] = amount * Math.min(1, (i - start) * dt / .020, (end - 1 - i) * dt / .020);
        result[i] = { ...points[i], frequency: mix[i] ? 2 ** (logF[i] + mix[i] * (sum / weight - logF[i])) : points[i].frequency };
      }
    }
    // Integrate frequency edits into phase. Merely changing endpoint frequencies
    // would leave the original phase fluctuations inside each cubic segment.
    for (let i = 1; i < points.length; i++) {
      const seconds = (points[i].frame - points[i - 1].frame) * dt;
      const originalStep = TAU * (points[i - 1].frequency + points[i].frequency) * .5 * seconds;
      const raw = points[i].phase - points[i - 1].phase;
      const unwrapped = raw + TAU * Math.round((originalStep - raw) / TAU);
      const newStep = TAU * (result[i - 1].frequency + result[i].frequency) * .5 * seconds;
      const strength = Math.min(mix[i - 1], mix[i]);
      result[i].phase = result[i - 1].phase + unwrapped + (newStep - originalStep) - strength * (unwrapped - originalStep);
    }
    return result;
  }
  async function render(percent, request, token, smoothing = 0, frequencySmoothing = 0, capture = false, ratio = 1) {
    const yieldIfNeeded = checkpoint();
    if (!model) throw new Error('Analise uma amostra primeiro.');
    const { tracks, length } = model;
    const count = tracks.length ? Math.max(1, Math.ceil(tracks.length * Math.max(25, Math.min(100, percent)) / 100)) : 0;
    const result = new Float32Array(length), dt = HOP / SR;
    let frequencies = new Float64Array(0), phases = new Float64Array(0);
    for (let index = 0; index < count; index++) {
      const tuned = smoothFrequencies(tracks[index].points, Math.max(0, Math.min(100, Number(frequencySmoothing) || 0)) / 100);
      let points = smoothAmplitudes(tuned, Math.max(0, Math.min(100, Number(smoothing) || 0)) / 100);
      if (ratio !== 1 && points.length) {
        if (frequencies.length < points.length) { frequencies = new Float64Array(points.length); phases = new Float64Array(points.length); }
        let phase = points[0].phase;
        for (let i = 0; i < points.length; i++) {
          const point = points[i];
          if (i) {
            const prior = points[i - 1], expected = TAU * (prior.frequency + point.frequency) * .5 * (point.frame - prior.frame) * dt;
            const raw = point.phase - prior.phase;
            phase += (raw + TAU * Math.round((expected - raw) / TAU)) * ratio;
          }
          phases[i] = phase; frequencies[i] = point.frequency * ratio;
        }
      }
      const a = {}, b = {};
      const endpoint = (target, index) => {
        const i = Math.max(0, Math.min(points.length - 1, index)), point = points[i];
        target.frame = point.frame; target.amplitude = point.amplitude;
        target.frequency = ratio === 1 ? point.frequency : frequencies[i];
        target.phase = ratio === 1 ? point.phase : phases[i];
        if (index < 0) { target.frame--; target.amplitude = 0; target.phase -= TAU * target.frequency * dt; }
        if (index >= points.length) { target.frame++; target.amplitude = 0; target.phase += TAU * target.frequency * dt; }
      };
      for (let j = -1; points.length && j < points.length; j++) {
        endpoint(a, j); endpoint(b, j + 1);
        const start = a.frame * HOP, end = b.frame * HOP, span = end - start;
        if (ratio !== 1 && Math.max(a.frequency, b.frequency) >= SR / 2) continue;
        const p0 = a.phase % TAU, expected = TAU * (a.frequency + b.frequency) / 2 * span / SR;
        const raw = b.phase - a.phase;
        const change = raw + TAU * Math.round((expected - raw) / TAU);
        const v0 = TAU * a.frequency * span / SR, v1 = TAU * b.frequency * span / SR;
        // Cubic phase interpolation matches phase and frequency at both ends.
        const c2 = 3 * change - 2 * v0 - v1, c3 = -2 * change + v0 + v1;
        for (let n = Math.max(0, start); n < Math.min(length, end); n++) {
          const u = (n - start) / span;
          result[n] += (a.amplitude + (b.amplitude - a.amplitude) * u) * Math.cos(p0 + u * (v0 + u * (c2 + u * c3)));
        }
      }
      if (index % 12 === 0) { if (!capture) report('Reconstruindo com senoides…', index / Math.max(1, count) * 100); await yieldIfNeeded(); if (token !== revision) return; }
    }
    let peak = 0;
    for (const sample of result) peak = Math.max(peak, Math.abs(sample));
    const gain = peak > .98 ? .98 / peak : 1;
    const fade = Math.min(240, Math.floor(length / 2));
    for (let n = 0; n < length; n++) result[n] *= gain * Math.min(1, n / Math.max(1, fade), (length - 1 - n) / Math.max(1, fade));
    if (token === revision) {
      const output = { type: 'rendered', request, count, samples: result, gain };
      if (!capture) self.postMessage(output, [result.buffer]);
      return output;
    }
  }
  async function adjustTracks(entries, residuals, pass, deadline, alive = () => true, progress = () => {}) {
    const yieldIfNeeded = checkpoint();
    const result = []; let processed = 0;
    for (const entry of entries) {
      const points = [];
      for (const point of entry.track.points) {
            const center = point.frame * HOP;
            let cc = 0, ss = 0, cs = 0, rc = 0, rs = 0;
            for (let n = Math.max(0, center - HOP); n < Math.min(residuals.length, center + HOP); n++) {
              const offset = n - center, weight = adjustmentWindow[offset + HOP];
              const phase = point.phase + TAU * point.frequency * offset / SR, c = Math.cos(phase), s = Math.sin(phase);
              const residual = residuals[n];
              cc += weight * c * c; ss += weight * s * s; cs += weight * c * s; rc += weight * residual * c; rs += weight * residual * s;
            }
            const det = cc * ss - cs * cs, step = .6 / (1 + pass * .5), limit = point.amplitude * .35;
            const clamp = value => Math.max(-limit, Math.min(limit, value * step));
            const da = det > 1e-12 ? clamp((rc * ss - rs * cs) / det) : 0;
            const db = det > 1e-12 ? clamp((rs * cc - rc * cs) / det) : 0;
            const real = point.amplitude + da;
            points.push({ ...point, amplitude: Math.hypot(real, db), phase: point.phase + Math.atan2(-db, real) });

        if (++processed % 64 === 0) {
          progress(processed); await yieldIfNeeded();
          if (!alive() || Date.now() > deadline) return { aborted: true, entries: [] };
        }
      }
      result.push({ index: entry.index, track: { ...entry.track, points } });
    }
    return { aborted: false, entries: result };
  }
  async function refine(samples, percent, request, token, smoothing, frequencySmoothing) {
    const yieldIfNeeded = checkpoint();
    if (!model || !(samples instanceof Float32Array) || samples.length !== model.length) throw new Error('A análise profunda precisa do áudio original desta amostra.');
    const started = Date.now(), deadline = started + 60000, passes = 4, prior = model;
    const valid = () => token === revision;
    const announce = (text, progress, improvement = 0) => self.postMessage({ type: 'deepProgress', request, text, progress, improvement, elapsed: (Date.now() - started) / 1000 });
    // Freeze the already-approved legacy effects into parameters, never into stored audio.
    let bestModel = { ...model, tracks: [] };
    for (let i = 0; i < model.tracks.length; i++) {
      const track = model.tracks[i];
      bestModel.tracks.push({ ...track, points: smoothAmplitudes(smoothFrequencies(track.points, Math.max(0, Math.min(100, frequencySmoothing || 0)) / 100), Math.max(0, Math.min(100, smoothing || 0)) / 100) });
      if (i % 32 === 0) { await yieldIfNeeded(); if (!valid()) return; }
    }
    model = bestModel;
    let best;
    try {
      announce('Medindo a reconstrução inicial…', 2);
      best = await render(percent, request, token, 0, 0, true); if (!valid()) return;
      const reference = [], scratch = new Map(), measuredBuffers = [];
      const residuals = new Float64Array(samples.length);
      const referenceEnvelope = new Float64Array(Math.ceil(samples.length / HOP));
      let total = 0, envelopeTotal = 0;
      for (let start = 0; start < samples.length; start += HOP) {
        let energy = 0;
        for (let i = start; i < Math.min(samples.length, start + HOP); i++) { energy += samples[i] ** 2; total += samples[i] ** 2; }
        referenceEnvelope[start / HOP] = Math.sqrt(energy); envelopeTotal += energy;
      }
      // Two spectral resolutions + short-window energy + phase-sensitive waveform error.
      async function features(signal, reuse = false) {
        const output = [];
        for (const size of [512, 2048]) {
          const hop = size / 2, frames = Math.ceil(signal.length / hop), bins = size / 2;
          const slot = output.length;
          const values = reuse ? (measuredBuffers[slot] ||= new Float32Array(frames * bins)) : new Float32Array(frames * bins);
          if (!scratch.has(size)) scratch.set(size, { real: new Float64Array(size), imag: new Float64Array(size), window: Float64Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(TAU * i / size)) });
          const { real, imag, window } = scratch.get(size);
          for (let frame = 0; frame < frames; frame++) {
            for (let n = 0; n < size; n++) { real[n] = (signal[frame * hop + n - size / 2] || 0) * window[n]; imag[n] = 0; }
            fft(real, imag);
            for (let k = 0; k < bins; k++) values[frame * bins + k] = Math.hypot(real[k], imag[k]) / size;
            if (frame % 32 === 0) { await yieldIfNeeded(); if (!valid()) return null; }
          }
          output.push(values);
        }
        return output;
      }
      const target = await features(samples); if (!valid()) return;
      reference.push(...target);
      const referenceEnergy = reference.map(values => { let energy = 0; for (const a of values) energy += a * a; return energy; });
      async function score(signal) {
        const measured = await features(signal, true); if (!measured) return Infinity;
        let spectral = 0;
        for (let resolution = 0; resolution < reference.length; resolution++) {
          let error = 0;
          for (let i = 0; i < reference[resolution].length; i++) { const a = reference[resolution][i], b = measured[resolution][i]; error += (a - b) ** 2; }
          spectral += error / Math.max(referenceEnergy[resolution], 1e-20) / reference.length;
        }
        let waveform = 0, envelope = 0;
        for (let start = 0; start < samples.length; start += HOP) {
          let b = 0;
          for (let i = start; i < Math.min(samples.length, start + HOP); i++) { b += signal[i] ** 2; waveform += (samples[i] - signal[i]) ** 2; }
          envelope += (referenceEnvelope[start / HOP] - Math.sqrt(b)) ** 2;
        }
        return .6 * spectral + .25 * envelope / Math.max(envelopeTotal, 1e-20) + .15 * waveform / Math.max(total, 1e-20);
      }
      let bestScore = await score(best.samples); if (!valid()) return;
      const initialScore = bestScore;
      let accepted = 0, iterations = 0, timedOut = false;
      const improvement = () => initialScore > 1e-20 ? Math.max(0, (1 - bestScore / initialScore) * 100) : 0;
      for (let pass = 0; pass < passes && !cancelDeep && bestScore > 1e-12; pass++) {
        if (Date.now() > deadline) { timedOut = true; break; }
        const candidate = { ...bestModel, tracks: bestModel.tracks.slice() };
        const entries = bestModel.tracks.slice(0, best.count).map((track, index) => ({ index, track }));
        const totalPoints = entries.reduce((sum, entry) => sum + entry.track.points.length, 0);

        for (let n = 0; n < samples.length; n++) residuals[n] = samples[n] - best.samples[n];
        let adjusted;
        if (parallelism > 1 && entries.length > 1 && totalPoints >= 256) {
          announce('Iteração ' + (pass + 1) + '/' + passes + ' · Ajustando parciais em paralelo…', 10 + pass / passes * 85, improvement());
          const groups = Array.from({ length: Math.min(parallelism, entries.length) }, () => ({ entries: [], points: 0 }));
          for (const entry of [...entries].sort((a, b) => b.track.points.length - a.track.points.length)) {
            const group = groups.reduce((a, b) => a.points <= b.points ? a : b);
            group.entries.push(entry); group.points += entry.track.points.length;
          }
          const local = groups.shift().entries;
          const remote = new Promise(resolve => {
            adjustment = { request, pass, resolve };
            self.postMessage({ type: 'adjustRequest', request, pass, entries: groups.flatMap(group => group.entries), residuals, deadline, parallelism });
          });
          const results = await Promise.all([remote, adjustTracks(local, residuals, pass, deadline, () => valid() && !cancelDeep)]);
          adjusted = { entries: results.flatMap(result => result.entries || []), aborted: results.some(result => result.aborted), error: results.find(result => result.error)?.error };
          if (!valid()) return;
          if (adjusted.error) throw new Error(adjusted.error);
        } else {
          adjusted = await adjustTracks(entries, residuals, pass, deadline, () => valid() && !cancelDeep, processed => {
            announce('Iteração ' + (pass + 1) + '/' + passes + ' · Ajustando amplitudes e fases…', 10 + (pass + processed / Math.max(1, totalPoints)) / passes * 85, improvement());
          });
          if (!valid()) return;
        }
        const aborted = adjusted.aborted;
        if (aborted) timedOut = !cancelDeep;
        for (const entry of adjusted.entries || []) candidate.tracks[entry.index] = entry.track;
        if (aborted || cancelDeep) break;
        model = candidate;
        const rendered = await render(percent, request, token, 0, 0, true); if (!valid()) return;
        if (cancelDeep) break;
        announce(`Iteração ${pass + 1}/${passes} · Comparando com o original…`, 10 + (pass + .95) / passes * 85, improvement());
        const candidateScore = await score(rendered.samples); if (!valid()) return;
        iterations++;
        if (Number.isFinite(candidateScore) && candidateScore < bestScore - 1e-12) { bestScore = candidateScore; best = rendered; bestModel = candidate; accepted++; }
        model = bestModel;
      }
      if (!valid()) return;
      model = bestModel;
      const summary = { initialError: initialScore, finalError: bestScore, improvement: improvement(), iterations, accepted, cancelled: cancelDeep, timedOut, elapsed: (Date.now() - started) / 1000, percent };
      self.postMessage({ type: 'deepComplete', request, model, samples: best.samples, count: best.count, gain: best.gain, summary }, [best.samples.buffer]);
    } catch (error) { if (valid()) model = prior; throw error; }
  }
  self.onmessage = async ({ data }) => {
    if (data.type === 'adjustReply') {
      if (adjustment && adjustment.request === data.request && adjustment.pass === data.pass) { const pending = adjustment; adjustment = null; pending.resolve(data); }
      return;
    }
    if (data.type === 'adjustBatch') {
      try { const result = await adjustTracks(data.entries, data.residuals, data.pass, data.deadline); self.postMessage({ type: 'adjustResult', ...result }); }
      catch (error) { self.postMessage({ type: 'error', message: error.message }); }
      return;
    }
    if (data.type === 'cancelDeep') { cancelDeep = true; return; }
    // Library transport preserves the unmodified analysis for reversible edits.
    if (data.type === 'snapshot') { self.postMessage({ type: 'snapshot', model, request: data.request }); return; }
    if (data.type === 'restore') { ++revision; model = data.model; adjustment?.resolve({ aborted:true }); adjustment = null; return; }
    const token = ++revision;
    try {
      if (data.type === 'analyze') { model = null; await analyze(data.samples, data.root, token); }
      else if (data.type === 'render') await render(data.percent, data.request, token, data.smoothing, data.frequencySmoothing);
      else if (data.type === 'refine') { cancelDeep = false; await refine(data.samples, data.percent, data.request, token, data.smoothing, data.frequencySmoothing); }
      else if (data.type === 'prepare') {
        parallelism = Math.max(1, Math.floor(Number.isFinite(data.parallelism) ? data.parallelism : 1)); cancelDeep = false;
        let reference = data.samples;
        if (!reference) {
          self.postMessage({ type: 'deepProgress', request: data.request, text: 'Preparando referência dos parâmetros salvos…', progress: 0, improvement: 0, elapsed: 0 });
          const full = await render(100, data.request, token, data.smoothing, data.frequencySmoothing, true);
          if (token !== revision) return; reference = full.samples;
        }
        await refine(reference, data.percent, data.request, token, data.smoothing, data.frequencySmoothing);
      }
      else if (data.type === 'note') {
        const output = await render(data.percent, data.request, token, 0, 0, true, 2 ** ((data.note - data.root) / 12));
        if (token === revision) self.postMessage({ type: 'note', note: data.note, samples: output.samples }, [output.samples.buffer]);
      }
      else if (data.type === 'instrument') {
        model = { ...model, tracks: model.tracks.map(track => ({ ...track, points: smoothAmplitudes(smoothFrequencies(track.points, (data.frequencySmoothing || 0) / 100), (data.smoothing || 0) / 100) })) };
        const output = await render(data.percent, data.request, token, 0, 0, true);
        if (token === revision) self.postMessage({ type: 'deepComplete', request: data.request, model, samples: output.samples, count: output.count, summary: data.summary }, [output.samples.buffer]);
      }
    } catch (error) { if (token === revision) self.postMessage({ type: 'error', message: error.message }); }
  };
}

function samplePeakDb(samples) {
  let peak = 0;
  for (const sample of samples) if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}
function meterPercent(db) { return Math.max(0, Math.min(100, (db + 60) / 60 * 100)); }
function workerBudget(logicalProcessors) {
  const reported = Number.isFinite(logicalProcessors) ? Math.floor(logicalProcessors) : 1;
  return Math.max(1, reported - 2);
}
function normalizeAdsr(value = {}) {
  const clamp = (key, fallback, max) => Number.isFinite(value?.[key]) ? Math.max(0, Math.min(max, value[key])) : fallback;
  return { attack: clamp('attack', .006, 5), decay: clamp('decay', .15, 5), sustain: clamp('sustain', 1, 1), release: clamp('release', .1, 10) };
}
function envelopeLevel(envelope, elapsed) {
  if (elapsed < 0) return 0;
  if (elapsed < envelope.attack) return elapsed / envelope.attack;
  if (elapsed < envelope.attack + envelope.decay) return 1 + (envelope.sustain - 1) * (elapsed - envelope.attack) / envelope.decay;
  return envelope.sustain;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { spectralWorker, samplePeakDb, meterPercent, normalizeAdsr, envelopeLevel, workerBudget, parameterMessage, encodeInstrument, decodeInstrument };
if (typeof document !== 'undefined') (() => {
  const $ = id => document.getElementById(id), SR = 48000;
  const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const name = n => noteNames[n % 12] + (Math.floor(n / 12) - 1);
  let ctx, master, worker, original, synthesized, rawSynth, model, request = 0, loadId = 0, debounce;
  let importBuffer = null, timelinePeaks = null, trimStart = 0, trimEnd = 0, viewStart = 0, viewSpan = 0, trimDrag = null;
  let trimPreview = null, trimPreviewTicket = null;
  let trimPreviewFrame = 0, trimPreviewStarted = 0, trimPreviewOffset = 0, trimPreviewDuration = 0;
  let midiAccess, voices = new Map(), pending = new Map(), busy = false, activeRoot = 48;
  let activeId = null, sampleName = '', workerState = null, database = null, renameId = null, viewRevision = 0, isSavedInstrument = false, sourceName = '', saving = false;
  let legacySmoothing = 0, legacyFrequency = 0, deepRunning = false, deepSummary = null;
  let baseAnalysis = null, bankGeneration = 0, bankReady = false;
  let adjustmentWorkers = [], noteWorkers = [];
  const noteCache = new Map();
  const computeBudget = workerBudget(typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency);
  const FIRST_NOTE = 21, LAST_NOTE = 108, NOTE_COUNT = LAST_NOTE - FIRST_NOTE + 1, MAX_VOICES = 64;
  let adsr = normalizeAdsr(), adsrDrag = null;
  const releaseVoices = new Set();
  const library = new Map();
  let outputAnalyser, meterSamples, meterFrame = 0, memoryTimer = 0, telemetryActive = false;
  let meterTime = 0, heldDb = -60, holdUntil = 0, clipUntil = 0, displayedDb = -60, labelTime = 0;
  function updateMemoryMeter() {
    if (document.hidden) return;
    const memory = performance.memory, bytes = memory?.usedJSHeapSize;
    const available = Number.isFinite(bytes) && bytes >= 0;
    $('memoryValue').textContent = available ? `≈ ${(bytes / 1048576).toFixed(1)} MB` : 'N/D';
    $('memoryLabel').textContent = available ? 'MEMÓRIA JS' : 'MEMÓRIA';
    $('memoryMeter').title = available
      ? 'Estimativa da memória JavaScript informada pelo navegador. Não é a RAM total do app: pode omitir áudio, workers e outras alocações.'
      : 'Este navegador não disponibiliza a medição de memória JavaScript.';
  }
  function paintAudioMeter(now) {
    if (!telemetryActive) return;
    meterFrame = requestAnimationFrame(paintAudioMeter);
    if (document.hidden || now - meterTime < 33) return;
    const seconds = meterTime ? Math.min(.2, (now - meterTime) / 1000) : 0; meterTime = now;
    let db = -Infinity;
    if (outputAnalyser && ctx?.state === 'running') { outputAnalyser.getFloatTimeDomainData(meterSamples); db = samplePeakDb(meterSamples); }
    displayedDb = Math.max(-60, db, displayedDb - seconds * 24);
    if (db >= heldDb) { heldDb = Math.max(-60, db); holdUntil = now + 1000; }
    else if (now > holdUntil) heldDb = Math.max(-60, displayedDb, heldDb - seconds * 18);
    if (db >= 0) clipUntil = now + 1500;
    $('audioMeterFill').style.clipPath = `inset(0 ${100 - meterPercent(displayedDb)}% 0 0)`;
    $('audioMeterPeak').style.left = `${meterPercent(heldDb)}%`;
    $('audioMeter').classList.toggle('clipping', now < clipUntil);
    if (now - labelTime > 120) {
      labelTime = now;
      $('audioDb').textContent = displayedDb <= -60 ? (db === -Infinity ? '−∞' : '< −60') : displayedDb.toFixed(1);
      $('audioMeter').setAttribute('aria-valuenow', String(Math.max(-60, Math.min(0, displayedDb))));
      $('audioMeter').setAttribute('aria-valuetext', `${$('audioDb').textContent} dBFS${now < clipUntil ? ', limite digital atingido' : ''}`);
    }
  }
  function startTelemetry() {
    if (telemetryActive || typeof requestAnimationFrame !== 'function') return;
    telemetryActive = true; updateMemoryMeter();
    memoryTimer = setInterval(updateMemoryMeter, 2000); meterFrame = requestAnimationFrame(paintAudioMeter);
  }
  function stopTelemetry() {
    telemetryActive = false; cancelAnimationFrame(meterFrame); clearInterval(memoryTimer);
  }
  const status = (text, value = 0) => { $('status').textContent = text; $('progress').value = value; };
  function showView(results, animate = false) {
    const generation = ++viewRevision, incoming = $(results ? 'results' : 'setup'), outgoing = $(results ? 'setup' : 'results');
    for (const panel of [$('setup'), $('results')]) { panel.getAnimations().forEach(a => a.cancel()); panel.classList.remove('fade-in', 'fade-out'); }
    const wasVisible = !outgoing.hidden;
    incoming.hidden = false; incoming.inert = false; outgoing.inert = true;
    updateInstrumentUI();
    $('reimport').hidden = !results || isSavedInstrument;
    if (animate && wasVisible && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      incoming.classList.add('fade-in'); outgoing.classList.add('fade-out');
      Promise.allSettled([...incoming.getAnimations(), ...outgoing.getAnimations()].map(a => a.finished)).then(() => {
        if (generation !== viewRevision) return;
        outgoing.hidden = true; incoming.classList.remove('fade-in'); outgoing.classList.remove('fade-out');
      });
    } else outgoing.hidden = true;
    if (results && document.activeElement?.closest('#setup')) (isSavedInstrument ? $('midi') : $('reimport')).focus();
  }
  function renderLibrary() {
    const focused = document.activeElement;
    const focusId = focused?.closest('.sample-item')?.dataset.id, focusOptions = focused?.classList.contains('sample-options');
    $('sampleList').replaceChildren();
    for (const record of library.values()) {
      const item = document.createElement('div'); item.className = 'sample-item' + (activeId === record.id ? ' selected' : ''); item.dataset.id = record.id;
      const select = document.createElement('button'); select.className = 'sample-select'; select.setAttribute('aria-pressed', String(activeId === record.id)); select.title = record.name;
      const label = document.createElement('span'); label.className = 'sample-name'; label.textContent = record.name;
      const detail = document.createElement('span'); detail.className = 'sample-detail'; detail.textContent = `${name(record.root)} · ${record.visual.duration.toFixed(2)} s`;
      select.append(label, detail); select.onclick = () => selectSample(record.id);
      const options = document.createElement('button'); options.className = 'sample-options'; options.textContent = '⋯'; options.setAttribute('aria-label', `Opções de ${record.name}`); options.title = 'Opções do sample';
      options.onclick = () => { renameId = record.id; $('optionsTitle').textContent = record.name; $('optionsError').textContent = ''; $('optionsDialog').showModal(); };
      item.append(select, options); $('sampleList').append(item);
      if (focusId === record.id) (focusOptions ? options : select).focus({ preventScroll: true });
    }
    $('sampleCount').textContent = library.size;
    $('libraryEmpty').hidden = library.size > 0;
  }
  function updateInstrumentUI() {
    $('adsrPanel').hidden = !isSavedInstrument; syncAdsr();
    $('comparison').hidden = isSavedInstrument;
    document.querySelector('.controls').classList.toggle('saved-instrument', isSavedInstrument);
    $('reimport').hidden = isSavedInstrument || $('results').hidden;
    $('saveInstrument').disabled = !rawSynth || !workerState || saving || deepRunning;
    $('deepPanel').hidden = false;
    $('amount').disabled = isSavedInstrument || !model?.total || saving;
    $('amount').title = isSavedInstrument ? 'Seleção definitiva do instrumento salvo.' : '';
    $('selectionLocked').hidden = !isSavedInstrument;
    $('reimport').disabled = deepRunning;

  }
  function persist(record) {
    return new Promise(resolve => {
      if (!database) { $('storageStatus').textContent = 'Armazenamento indisponível'; resolve(false); return; }
      try {
        const transaction = database.transaction('samples', 'readwrite'); transaction.objectStore('samples').put(record);
        transaction.oncomplete = () => { $('storageStatus').textContent = 'Salvos neste navegador'; resolve(true); };
        transaction.onabort = transaction.onerror = () => { $('storageStatus').textContent = 'Não foi possível salvar no dispositivo'; resolve(false); };
      } catch { $('storageStatus').textContent = 'Armazenamento indisponível'; resolve(false); }
    });
  }
  function instrumentRecord(value = sampleName) {
    const percent = isSavedInstrument ? library.get(activeId)?.percent ?? +$('amount').value : +$('amount').value;
    const count = isSavedInstrument ? workerState.tracks.length : Math.ceil(workerState.tracks.length * percent / 100);
    return { id: activeId, kind: 'instrument', version: 2, baked: true, name: value, sourceName, adsr: { ...adsr },
      root: activeRoot, percent, smoothing: 0, frequencySmoothing: 0, refinement: deepSummary,
      visual: model, parameters: isSavedInstrument && library.get(activeId)?.version === 2 ? library.get(activeId).parameters : encodeInstrument(workerState, count), selected: String(count) };
  }
  function saveCurrent() {
    updateInstrumentUI();
    if (!isSavedInstrument || !activeId || !synthesized || !model || !workerState) return;
    const record = instrumentRecord();
    library.set(activeId, record); renderLibrary(); persist(record);
  }
  $('saveInstrument').onclick = () => {
    if (!original || !synthesized || !workerState) return;
    $('instrumentName').value = sourceName || sampleName;
    $('saveError').textContent = ''; $('instrumentName').setCustomValidity('');
    $('saveDialog').showModal(); $('instrumentName').select();
  };
  $('cancelSave').onclick = () => { if (!saving) $('saveDialog').close(); };
  $('saveDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('instrumentName').oninput = () => $('instrumentName').setCustomValidity('');
  $('saveForm').onsubmit = async event => {
    event.preventDefault(); if (saving || deepRunning || !original || !workerState || !synthesized) return;
    const value = $('instrumentName').value.trim();
    if (!value) { $('instrumentName').setCustomValidity('Digite um nome para o instrumento.'); $('instrumentName').reportValidity(); return; }
    saving = true; $('confirmSave').disabled = $('cancelSave').disabled = true;
    const record = instrumentRecord(value), success = await persist(record);
    saving = false; $('confirmSave').disabled = $('cancelSave').disabled = false;
    if (!success) { $('saveError').textContent = 'Não foi possível salvar. O áudio original foi mantido; tente novamente.'; return; }
    stop(); original = null; rawSynth = null; baseAnalysis = null; workerState = decodeInstrument(record.parameters); $('file').value = '';
    isSavedInstrument = true; sampleName = value; library.set(activeId, record); renderLibrary();
    $('original').disabled = $('analyze').disabled = true;
    $('fileName').textContent = 'Instrumento salvo por parâmetros.'; $('sampleTitle').textContent = value;
    $('saveDialog').close(); updateInstrumentUI();
    status('Instrumento salvo. Áudio original liberado; pronto para tocar.', 100);
  };
  async function selectSample(id) {
    const record = library.get(id); if (!record) return;
    const generation = ++loadId; invalidate(); activeId = id; isSavedInstrument = record.kind === 'instrument'; sourceName = record.sourceName || record.fileLabel?.split(' · ')[0].replace(/\.[^.]+$/, '') || record.name; renderLibrary();
    original = null; $('original').disabled = $('analyze').disabled = true;
    try {
      await audio(); if (generation !== loadId) return;
      sampleName = record.name; activeRoot = record.root; $('root').value = record.root; $('amount').value = record.percent; $('percent').value = `${record.percent}%`;
      adsr = normalizeAdsr(record.adsr); syncAdsr();
      legacySmoothing = record.smoothing ?? 0; legacyFrequency = record.frequencySmoothing ?? 0; deepSummary = record.refinement || null;
      if (!record.baseAnalysis && (record.baked || record.refinement)) legacySmoothing = legacyFrequency = 0;
      if (!isSavedInstrument) {
        original = ctx.createBuffer(1, record.original.length, SR); original.copyToChannel(record.original, 0);
        rawSynth = record.synthesized; synthesized = ctx.createBuffer(1, rawSynth.length, SR); synthesized.copyToChannel(rawSynth, 0);
      }
      model = record.visual; workerState = record.version === 2 ? decodeInstrument(record.parameters) : record.analysis; baseAnalysis = isSavedInstrument ? null : record.baseAnalysis || record.analysis; resetWorker(); worker.postMessage({ type: 'restore', model: workerState });
      $('fileName').textContent = record.fileLabel || 'Instrumento salvo por parâmetros.'; $('sampleTitle').textContent = record.name;
      $('total').textContent = model.total.toLocaleString('pt-BR'); $('selected').textContent = record.selected;
      $('duration').textContent = `${model.duration.toFixed(2)} s`; $('empty').style.display = 'none';
      $('amount').disabled = isSavedInstrument || !model.total; $('original').disabled = $('analyze').disabled = isSavedInstrument;
      keyboard(); playbackReady(false); draw(); showView(true);
      if (isSavedInstrument) {
        deepRunning = true; processing('Preparando o instrumento salvo…', 0); updateInstrumentUI();
        worker.postMessage({ type: 'instrument', request, percent: record.version === 2 ? 100 : record.percent, summary: deepSummary,
          smoothing: record.baked || deepSummary ? 0 : legacySmoothing, frequencySmoothing: record.baked || deepSummary ? 0 : legacyFrequency });
      } else rebuild();
    } catch (error) { status(`Não foi possível abrir o sample: ${error.message}`); showView(false); }
  }
  function newSample() {
    adsr = normalizeAdsr(); syncAdsr();
    ++loadId; invalidate(); original = null; activeId = null; sampleName = ''; sourceName = ''; isSavedInstrument = false;
    $('root').value = '48'; activeRoot = 48; $('amount').value = '100'; $('percent').value = '100%';
    legacySmoothing = legacyFrequency = 0;
    $('sampleTitle').textContent = 'Novo sample'; $('fileName').textContent = 'WAV, MP3 ou outro formato aceito pelo navegador. Selecione até 10 s; arquivos até 512 MB.';
    $('original').disabled = $('analyze').disabled = true; keyboard(); renderLibrary(); showView(false); status('Importe uma amostra para começar.');
  }
  function openLibrary() {
    try {
      const opening = indexedDB.open('spectral-resynth-library', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('samples', { keyPath: 'id' });
      opening.onerror = () => { $('storageStatus').textContent = 'Biblioteca disponível nesta sessão'; };
      opening.onblocked = () => { $('storageStatus').textContent = 'Feche outras abas para habilitar o armazenamento'; };
      opening.onsuccess = () => {
        database = opening.result;
        database.onversionchange = () => { database.close(); database = null; $('storageStatus').textContent = 'Reabra o app para atualizar a biblioteca'; };
        const reading = database.transaction('samples').objectStore('samples').getAll();
        reading.onsuccess = () => { for (const record of reading.result) if (!library.has(record.id)) library.set(record.id, record); renderLibrary(); for (const record of library.values()) if (!reading.result.some(saved => saved.id === record.id)) persist(record); };
        reading.onerror = () => { $('storageStatus').textContent = 'Não foi possível carregar a biblioteca'; };
      };
    } catch { $('storageStatus').textContent = 'Biblioteca disponível nesta sessão'; }
  }
  $('newSample').onclick = newSample;
  $('reimport').onclick = () => { if (isSavedInstrument) return; stop(); showView(false); status('Importe outro áudio ou ajuste a fundamental e analise novamente.'); };
  $('closeOptions').onclick = () => $('optionsDialog').close();
  $('renameOption').onclick = () => {
    const record = library.get(renameId); if (!record) return;
    $('optionsDialog').close(); $('sampleName').value = record.name; $('sampleName').setCustomValidity('');
    $('renameDialog').showModal(); $('sampleName').select();
  };
  $('deleteOption').onclick = async () => {
    const id = renameId; if (!library.has(id)) return;
    // Cancel pending renders so an autosave cannot recreate the deleted record.
    const wasActive = activeId === id;
    if (wasActive) { ++loadId; invalidate(); original = null; }
    $('deleteOption').disabled = true;
    const success = await new Promise(resolve => {
      if (!database) { resolve(false); return; }
      try {
        const transaction = database.transaction('samples', 'readwrite'); transaction.objectStore('samples').delete(id);
        transaction.oncomplete = () => resolve(true); transaction.onerror = transaction.onabort = () => resolve(false);
      } catch { resolve(false); }
    });
    $('deleteOption').disabled = false;
    if (!success) { $('optionsError').textContent = 'Não foi possível excluir. Tente novamente.'; if (wasActive) await selectSample(id); return; }
    library.delete(id); $('optionsDialog').close();
    if (activeId === id) newSample(); else renderLibrary();
    status('Som excluído da biblioteca.');
  };
  $('cancelRename').onclick = () => $('renameDialog').close();
  $('renameForm').onsubmit = event => {
    event.preventDefault(); const record = library.get(renameId), value = $('sampleName').value.trim();
    if (!value) { $('sampleName').setCustomValidity('Digite um nome para o sample.'); $('sampleName').reportValidity(); return; }
    if (record) { record.name = value; if (activeId === record.id) { sampleName = value; $('sampleTitle').textContent = value; } persist(record); renderLibrary(); }
    $('renameDialog').close();
  };
  $('sampleName').oninput = () => $('sampleName').setCustomValidity('');
  for (let n = 12; n <= 108; n++) { const option = new Option(`${name(n)} · ${(440 * 2 ** ((n - 69) / 12)).toFixed(2)} Hz`, n); $('root').add(option); }
  $('root').value = '48';
  async function audio() {
    if (!ctx) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('Este navegador não oferece Web Audio.');
      ctx = new Audio({ sampleRate: SR }); master = ctx.createGain();
      master.gain.value = +$('volume').value / 100 * .6;
      const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 3; limiter.ratio.value = 20; limiter.attack.value = .003; limiter.release.value = .15;
      master.connect(limiter); limiter.connect(ctx.destination);
      // A parallel analysis tap leaves the existing audible signal path untouched.
      outputAnalyser = ctx.createAnalyser(); outputAnalyser.fftSize = 2048;
      meterSamples = new Float32Array(outputAnalyser.fftSize); limiter.connect(outputAnalyser);
    }
    await ctx.resume(); return ctx;
  }
  function playbackReady(ready) { $('saveInstrument').disabled = !ready || !workerState || deepRunning;  $('resynth').disabled = $('download').disabled = !ready; document.querySelectorAll('.key').forEach(k => k.disabled = !ready || !bankReady); }
  function disposeVoice(voice) {
    voice.source.disconnect(); voice.gain.disconnect(); releaseVoices.delete(voice);
    if (voices.get(voice.id) === voice) { voices.delete(voice.id); voice.key?.classList.remove('active'); }
  }
  function killVoice(voice) { voice.source.onended = null; voice.source.stop(); disposeVoice(voice); }
  function release(id) {
    pending.delete(id);
    const voice = voices.get(id); if (!voice || !ctx) return;
    const now = ctx.currentTime, level = voice.peak * envelopeLevel(voice.envelope, now - voice.started);
    voice.gain.gain.cancelScheduledValues(now); voice.gain.gain.setValueAtTime(level, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + voice.envelope.release);
    voice.source.stop(now + voice.envelope.release); voices.delete(id); releaseVoices.add(voice); voice.key?.classList.remove('active');
  }
  function stop() { stopTrimPreview(); pending.clear(); for (const voice of [...voices.values(), ...releaseVoices]) killVoice(voice); }
  async function play(buffer, note, id, velocity = 100, key) {
    try {
      if (!buffer) return;
      const generation = request;
      const ticket = {}; pending.set(id, ticket);
      await audio();
      if (buffer === synthesized && id !== 'preview') {
        if (!bankReady) { pending.delete(id); return; }
        buffer = await getNote(note);
      }
      if (!buffer || generation !== request || pending.get(id) !== ticket) { if (pending.get(id) === ticket) pending.delete(id); return; }
      release(id);
      if (voices.size + releaseVoices.size >= MAX_VOICES) killVoice(releaseVoices.values().next().value || voices.values().next().value);
      const source = ctx.createBufferSource(), gain = ctx.createGain(); source.buffer = buffer;
      source.playbackRate.value = 1;
      const envelope = isSavedInstrument && id !== 'preview' ? { ...adsr } : normalizeAdsr();
      const peak = velocity / 127 * .65, started = ctx.currentTime;
      gain.gain.setValueAtTime(0, started);
      gain.gain.linearRampToValueAtTime(peak, started + envelope.attack);
      gain.gain.linearRampToValueAtTime(peak * envelope.sustain, started + envelope.attack + envelope.decay);
      source.connect(gain); gain.connect(master); const voice = { id, source, gain, key, envelope, peak, started }; voices.set(id, voice); key?.classList.add('active');
      source.onended = () => disposeVoice(voice);
      source.start(started);
    } catch (e) { status(e.message); }
  }
  function syncAdsr() {
    for (const [key, id] of Object.entries({ attack: 'adsrAttack', decay: 'adsrDecay', sustain: 'adsrSustain', release: 'adsrRelease' })) {
      if (document.activeElement !== $(id)) $(id).value = key === 'sustain' ? Math.round(adsr[key] * 100) : +adsr[key].toFixed(3);
    }
    drawAdsr();
  }
  function adsrGeometry() {
    const span = adsrDrag?.span || Math.max(1, (adsr.attack + adsr.decay + 1 + adsr.release) * 1.25), x = t => 20 + t / span * 460;
    const y = 115 - adsr.sustain * 95, decayEnd = adsr.attack + adsr.decay, sustainEnd = decayEnd + 1;
    return { span, points: [[x(adsr.attack), 20], [x(decayEnd), y], [x(sustainEnd), y], [x(sustainEnd + adsr.release), 115]] };
  }
  function drawAdsr() {
    if (!isSavedInstrument) return;
    const { points } = adsrGeometry();
    $('adsrCurve').setAttribute('d', 'M20 115 ' + points.map(([x, y]) => `L${x} ${y}`).join(' '));
    $('adsrHandles').innerHTML = points.map(([x, y], i) => `<g data-stage="${i}"><circle cx="${x}" cy="${y}" r="7"/><text x="${x}" y="${Math.max(12, y - 13)}" text-anchor="middle">${['A','D','S','R'][i]}</text></g>`).join('');
  }
  function storeAdsr() {
    if (!isSavedInstrument || !activeId) return;
    const record = library.get(activeId); if (!record) return;
    record.adsr = { ...adsr }; persist(record);
  }
  for (const [key, id] of Object.entries({ attack: 'adsrAttack', decay: 'adsrDecay', sustain: 'adsrSustain', release: 'adsrRelease' })) {
    $(id).oninput = () => {
      if (!isSavedInstrument || $(id).value === '') return;
      const value = Number($(id).value); if (!Number.isFinite(value)) return;
      adsr = normalizeAdsr({ ...adsr, [key]: key === 'sustain' ? value / 100 : value }); drawAdsr();
    };
    $(id).onchange = () => { $(id).value = key === 'sustain' ? Math.round(adsr[key] * 100) : +adsr[key].toFixed(3); storeAdsr(); };
  }
  function adsrPointer(event) {
    const rect = $('adsrGraph').getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * 500, y: (event.clientY - rect.top) / rect.height * 140 };
  }
  $('adsrGraph').onpointerdown = event => {
    if (!isSavedInstrument) return;
    const target = event.target.closest('[data-stage]'); if (!target) return;
    event.preventDefault(); $('adsrGraph').setPointerCapture(event.pointerId);
    adsrDrag = { stage: +target.dataset.stage, span: adsrGeometry().span, initial: { ...adsr } };
  };
  $('adsrGraph').onpointermove = event => {
    if (!adsrDrag || !isSavedInstrument) return;
    const { x, y } = adsrPointer(event), time = (x - 20) / 460 * adsrDrag.span, initial = adsrDrag.initial;
    if (adsrDrag.stage === 0) adsr.attack = time;
    if (adsrDrag.stage === 1) { adsr.decay = time - initial.attack; adsr.sustain = (115 - y) / 95; }
    if (adsrDrag.stage === 2) adsr.sustain = (115 - y) / 95;
    if (adsrDrag.stage === 3) adsr.release = time - initial.attack - initial.decay - 1;
    adsr = normalizeAdsr(adsr); syncAdsr();
  };
  $('adsrGraph').onpointerup = $('adsrGraph').onpointercancel = () => { if (adsrDrag) { adsrDrag = null; syncAdsr(); storeAdsr(); } };
  function keyboard() {
    $('keys').replaceChildren();
    const base = Math.max(FIRST_NOTE, Math.min(LAST_NOTE - 12, Math.floor(+$('root').value / 12) * 12));
    for (let n = base; n <= base + 12; n++) {
      const key = document.createElement('button'); key.className = 'key' + ([1, 3, 6, 8, 10].includes(n % 12) ? ' black' : '');
      key.textContent = name(n); key.setAttribute('aria-label', `Tocar ${name(n)}`); key.disabled = !synthesized;
      key.onpointerdown = e => { e.preventDefault(); key.setPointerCapture(e.pointerId); play(synthesized, n, `key${n}`, 100, key); };
      key.onpointerup = key.onpointercancel = () => release(`key${n}`);
      key.onkeydown = e => { if ([' ', 'Enter'].includes(e.key) && !e.repeat) { e.preventDefault(); play(synthesized, n, `key${n}`, 100, key); } };
      key.onkeyup = e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); release(`key${n}`); } };
      key.onblur = () => release(`key${n}`); $('keys').append(key);
    }
  }
  function draw() {
    const canvas = $('spectrum'), rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = window.devicePixelRatio || 1, w = rect.width, h = rect.height;
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const g = canvas.getContext('2d'); g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = '#060d14'; g.fillRect(0, 0, w, h);
    const compactPlot = h < 70;
    const left = compactPlot ? 4 : 38, top = compactPlot ? 3 : 10, pw = Math.max(1, w - left - 10), ph = Math.max(1, h - (compactPlot ? 6 : 32));
    if (model) {
      const small = document.createElement('canvas'); small.width = model.width; small.height = model.height;
      const sg = small.getContext('2d'), im = sg.createImageData(model.width, model.height);
      for (let i = 0; i < model.spectrum.length; i++) {
        const t = Math.max(0, Math.min(1, (model.spectrum[i] + 85) / 85)), j = i * 4;
        im.data[j] = 6 + 114 * t ** 2; im.data[j + 1] = 13 + 217 * t ** 1.5; im.data[j + 2] = 20 + 175 * t; im.data[j + 3] = 255;
      }
      sg.putImageData(im, 0, 0); g.drawImage(small, left, top, pw, ph);
      const count = Math.ceil(model.total * +$('amount').value / 100);
      g.strokeStyle = '#edbd77'; g.globalAlpha = .6; g.lineWidth = 1;
      g.save(); g.beginPath(); g.rect(left, top, pw, ph); g.clip();
      for (const track of model.display.slice(0, count)) {
        g.beginPath(); track.forEach(([t, f], i) => {
          const x = left + t / model.duration * pw, y = top + Math.log(20000 / f) / Math.log(1000) * ph;
          if (!i) g.moveTo(x, y); else g.lineTo(x, y);
        }); g.stroke();
      }
      g.restore(); g.globalAlpha = 1;
    }
    g.font = '10px Segoe UI, sans-serif'; g.fillStyle = '#a1b3c0'; g.strokeStyle = '#8296aa22';
    for (const f of (compactPlot ? [] : h < 120 ? [100, 1000, 10000] : [50, 100, 500, 1000, 5000, 10000])) {
      const y = top + Math.log(20000 / f) / Math.log(1000) * ph;
      g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 12, y + 4); g.beginPath(); g.moveTo(left, y); g.lineTo(w - 20, y); g.stroke();
    }
    if (model && !compactPlot) for (let i = 0; i <= 4; i++) g.fillText(`${(model.duration * i / 4).toFixed(1)} s`, left + pw * i / 4 - (i === 4 ? 30 : 0), h - 8);
  }
  function endAdjustmentWorkers() {
    for (const helper of adjustmentWorkers) helper.terminate(); adjustmentWorkers = [];
  }
  function createComputeWorker() {
    const source = parameterMessage.toString() + '\n(' + spectralWorker.toString() + ')();\n' +
      'const send = self.postMessage.bind(self); self.postMessage = (data, transfers = []) => { const list = [...transfers]; send(parameterMessage(data, true, list), list); };' +
      'const receive = self.onmessage; self.onmessage = event => receive({ data: parameterMessage(event.data, false) });';
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    let native;
    try { native = new Worker(url); } finally { URL.revokeObjectURL(url); }
    return {
      postMessage(data, transfers = []) { const list = [...transfers]; native.postMessage(parameterMessage(data, true, list), list); },
      set onmessage(callback) { native.onmessage = event => callback({ data: parameterMessage(event.data, false) }); },
      set onerror(callback) { native.onerror = callback; },
      terminate() { native.terminate(); }
    };
  }
  function distributeAdjustments(data) {
    const owner = worker, generation = request;
    const count = Math.min(computeBudget - 1, data.entries.length);
    if (count < 1) { owner.postMessage({ type: 'adjustReply', request: data.request, pass: data.pass, error: 'Não há workers disponíveis para a divisão.' }); return; }
    try {
      while (adjustmentWorkers.length < count) adjustmentWorkers.push(createComputeWorker());
      const groups = Array.from({ length: count }, () => ({ entries: [], points: 0 }));
      for (const entry of [...data.entries].sort((a, b) => b.track.points.length - a.track.points.length)) {
        const group = groups.reduce((a, b) => a.points <= b.points ? a : b);
        group.entries.push(entry); group.points += entry.track.points.length;
      }
      let remaining = count, aborted = false; const entries = [];
      groups.forEach((group, index) => {
        const helper = adjustmentWorkers[index];
        helper.onerror = () => { if (generation === request && owner === worker) recoverDeep('Falha no processamento paralelo.'); };
        helper.onmessage = ({ data: result }) => {
          if (generation !== request || owner !== worker) return;
          if (result.type === 'error') { recoverDeep(result.message); return; }
          if (result.type !== 'adjustResult') return;
          aborted ||= result.aborted; entries.push(...result.entries);
          if (--remaining === 0) owner.postMessage({ type: 'adjustReply', request: data.request, pass: data.pass, entries, aborted });
        };
        helper.postMessage({ type: 'adjustBatch', entries: group.entries, residuals: data.residuals, pass: data.pass, deadline: data.deadline });
      });
    } catch (error) { recoverDeep(error.message); }
  }
  function resetWorker() {
    endAdjustmentWorkers(); worker?.terminate();
    worker = createComputeWorker();
    worker.onerror = e => { worker?.terminate(); worker = null; endAdjustmentWorkers(); recoverDeep('Falha na análise profunda.'); busy = false; $('analyze').disabled = !original; status(`Falha no processamento: ${e.message || 'tente analisar novamente.'}`); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'adjustRequest' && data.request === request && deepRunning) distributeAdjustments(data);
      if (data.type === 'deepProgress' && data.request === request && deepRunning) processing(original ? data.text : data.text.replace('o original', 'a referência salva'), data.progress * .7);
      if (data.type === 'deepComplete' && data.request === request && deepRunning) {
        endAdjustmentWorkers(); worker?.terminate(); worker = null;
        workerState = isSavedInstrument ? { ...data.model, tracks: data.model.tracks.slice(0, data.count) } : data.model; deepSummary = data.summary;
        rawSynth = isSavedInstrument ? null : data.samples;
        synthesized = ctx.createBuffer(1, data.samples.length, SR); synthesized.copyToChannel(data.samples, 0);
        $('selected').textContent = data.count.toLocaleString('pt-BR'); $('resynth').textContent = '▶ Resíntese';
        prepareNotes(request);
      }
      if (data.type === 'snapshot' && data.request === request) { workerState = baseAnalysis = data.model; rebuild(); }
      if (data.type === 'progress') status(data.text, data.value);
      if (data.type === 'error') { worker?.terminate(); worker = null; endAdjustmentWorkers(); recoverDeep(data.message); busy = false; $('analyze').disabled = !original; status(data.message); }
      if (data.type === 'analyzed') {
        model = data; busy = false; $('analyze').disabled = false; $('total').textContent = data.total.toLocaleString('pt-BR');
        $('amount').disabled = !data.total; $('empty').style.display = 'none'; $('duration').textContent = data.duration.toFixed(2) + ' s';
        draw(); showView(true, true);
        if (data.total) worker.postMessage({ type: 'snapshot', request });
        else { worker?.terminate(); worker = null; status('Nenhum parcial válido encontrado. Experimente uma nota mais longa ou com mais volume.', 100); }
      }
    };
  }
  function invalidate(keepImport = false) {
    adsrDrag = null;
    if (!keepImport) { importBuffer = timelinePeaks = null; trimDrag = null; $('trimPanel').hidden = true; }
    deepRunning = false; deepSummary = baseAnalysis = null; clearNoteBank(); $('deepStatus').textContent = 'Refinamento automático e preparação das notas.'; $('processingProgress').value = 0;
    clearTimeout(debounce); request++; busy = false; stop(); worker?.terminate(); worker = null;
    synthesized = rawSynth = model = workerState = null; playbackReady(false); $('amount').disabled = true;
    $('selected').textContent = $('total').textContent = '—'; $('empty').style.display = 'flex'; $('duration').textContent = 'Tempo →'; draw();
  }
  async function loadFile(file) {
    if (!file) return;
    const id = ++loadId; invalidate(); legacySmoothing = legacyFrequency = 0; isSavedInstrument = false; original = null; $('original').disabled = $('analyze').disabled = true;
    try {
      if (file.size > 512 * 1024 * 1024) throw new Error('Use um arquivo de até 512 MB.');
      status('Decodificando áudio…'); await audio();
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      if (id !== loadId) return;
      const duration = decoded.duration;
      if (duration <= 0) throw new Error('O arquivo não contém áudio.');
      importBuffer = decoded; trimStart = viewStart = 0; trimEnd = Math.min(10, duration); viewSpan = duration;
      // Compact overview; only the chosen interval will be converted to mono and resampled.
      const bucket = 256, peaks = new Float32Array(Math.ceil(decoded.length / bucket));
      status('Preparando a linha do tempo…');
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        const channel = decoded.getChannelData(c);
        for (let i = 0; i < channel.length; i++) {
          peaks[Math.floor(i / bucket)] = Math.max(peaks[Math.floor(i / bucket)], Math.abs(channel[i]));
          if (i % 524288 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (id !== loadId) return; }
        }
      }
      timelinePeaks = peaks; $('trimPanel').hidden = false; updateTrim();
      sourceName = file.name.replace(/\.[^.]+$/, '');
      $('fileName').textContent = `${file.name} · ${duration.toFixed(2)} s · selecione até 10 s`;
      if (!activeId) { activeId = crypto.randomUUID(); sampleName = file.name.replace(/\.[^.]+$/, ''); }
      $('sampleTitle').textContent = sampleName; keyboard(); renderLibrary();
      $('analyze').disabled = false; activeRoot = +$('root').value;
      status('Selecione o trecho, confira a fundamental e clique em Analisar amostra.');
    } catch (e) { if (id === loadId) { importBuffer = timelinePeaks = null; $('trimPanel').hidden = true; status(`Não foi possível abrir o áudio: ${e.message}`); } }
  }
  function processing(text, value) {
    status(text, value); $('deepStatus').textContent = text; $('processingProgress').value = value;
  }
  function rebuild() {
    if (isSavedInstrument || !model?.total || !baseAnalysis) return;
    clearTimeout(debounce); stop(); clearNoteBank(); synthesized = rawSynth = null;
    deepRunning = true; playbackReady(false); const id = ++request;
    resetWorker(); worker.postMessage({ type: 'restore', model: baseAnalysis });
    $('selected').textContent = Math.ceil(model.total * +$('amount').value / 100).toLocaleString('pt-BR'); draw();
    processing('Reconstruindo e refinando a seleção…', 0); updateInstrumentUI();
    const samples = original?.getChannelData(0).slice();
    worker.postMessage({ type: 'prepare', parallelism: computeBudget, samples, percent: +$('amount').value, request: id, smoothing: legacySmoothing, frequencySmoothing: legacyFrequency }, samples ? [samples.buffer] : []);
  }
  function endNoteWorkers() {
    for (const helper of noteWorkers) helper.terminate(); noteWorkers = [];
  }
  function clearNoteBank() {
    ++bankGeneration; bankReady = false; endAdjustmentWorkers(); endNoteWorkers(); noteCache.clear();
  }
  function getNote(note) {
    return Promise.resolve(Number.isInteger(note) && note >= FIRST_NOTE && note <= LAST_NOTE ? noteCache.get(note) || null : null);
  }
  function prepareNotes(id) {
    const generation = bankGeneration, poolSize = Math.min(computeBudget, NOTE_COUNT); let next = FIRST_NOTE, completed = 0;
    const fail = message => {
      if (id !== request || generation !== bankGeneration) return;
      clearNoteBank(); deepRunning = false; playbackReady(false); updateInstrumentUI(); processing(message + ' Altere os parciais para tentar novamente.', 0);
    };
    const dispatch = helper => {
      if (next <= LAST_NOTE) helper.postMessage({ type: 'note', note: next++, root: activeRoot, percent: isSavedInstrument ? 100 : +$('amount').value, request: id });
    };
    try {
      processing('Preparando notas: 0/' + NOTE_COUNT + ' · ' + poolSize + ' workers…', 70);
      for (let i = 0; i < poolSize; i++) {
        const helper = createComputeWorker(); noteWorkers.push(helper);
        helper.onerror = () => fail('Falha ao preparar as notas.');
        helper.onmessage = ({ data }) => {
          if (id !== request || generation !== bankGeneration) return;
          if (data.type === 'error') { fail(data.message); return; }
          if (data.type !== 'note') return;
          try {
            const buffer = ctx.createBuffer(1, data.samples.length, SR); buffer.copyToChannel(data.samples, 0);
            noteCache.set(data.note, buffer); completed++;
            processing('Preparando notas: ' + completed + '/' + NOTE_COUNT + ' · ' + poolSize + ' workers…', 70 + completed / NOTE_COUNT * 30);
            if (completed === NOTE_COUNT) {
              endNoteWorkers(); deepRunning = false; bankReady = true; playbackReady(true); updateInstrumentUI(); saveCurrent();
              processing('Pronto · 88 notas preparadas · 64 vozes · workers liberados.' + (isSavedInstrument ? ' Seleção definitiva.' : ''), 100);
            } else dispatch(helper);
          } catch (error) { fail(error.message); }
        };
        helper.postMessage({ type: 'restore', model: workerState }); dispatch(helper);
      }
    } catch (error) { fail(error.message); }
  }
  function stopTrimPreview() {
    cancelAnimationFrame(trimPreviewFrame); trimPreviewFrame = 0; $('trimPlayhead').hidden = true;
    trimPreviewTicket = null;
    const source = trimPreview; trimPreview = null;
    if (source) { source.onended = null; source.stop(); source.disconnect(); }
    $('previewTrim').textContent = '▶ Ouvir trecho';
  }
  function paintTrimPlayhead() {
    if (!trimPreview) return;
    const position = trimPreviewOffset + Math.max(0, Math.min(trimPreviewDuration, ctx.currentTime - trimPreviewStarted));
    const fraction = (position - viewStart) / viewSpan;
    $('trimPlayhead').hidden = fraction < 0 || fraction > 1;
    $('trimPlayhead').style.left = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    trimPreviewFrame = requestAnimationFrame(paintTrimPlayhead);
  }
  $('previewTrim').onclick = async () => {
    if (trimPreviewTicket) { stopTrimPreview(); return; }
    if (!importBuffer || !timelinePeaks || busy) return;
    stop();
    const ticket = {}, buffer = importBuffer, start = trimStart, duration = Math.min(10, trimEnd - trimStart);
    trimPreviewTicket = ticket; $('previewTrim').textContent = '■ Parar trecho';
    try {
      await audio();
      if (trimPreviewTicket !== ticket || importBuffer !== buffer || busy) return;
      const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(master); trimPreview = source;
      source.onended = () => {
        source.disconnect();
        if (trimPreview === source) {
          trimPreview = trimPreviewTicket = null; cancelAnimationFrame(trimPreviewFrame); trimPreviewFrame = 0;
          $('trimPlayhead').hidden = true; $('previewTrim').textContent = '▶ Ouvir trecho';
        }
      };
      trimPreviewStarted = ctx.currentTime; trimPreviewOffset = start; trimPreviewDuration = duration;
      source.start(trimPreviewStarted, start, duration); paintTrimPlayhead();
    } catch (error) { if (trimPreviewTicket === ticket) { stopTrimPreview(); status(`Não foi possível ouvir o trecho: ${error.message}`); } }
  };
  function updateTrim() {
    if (!importBuffer) return;
    if (document.activeElement !== $('trimStart')) $('trimStart').value = trimStart.toFixed(3);
    if (document.activeElement !== $('trimEnd')) $('trimEnd').value = trimEnd.toFixed(3);
    $('trimStart').max = $('trimEnd').max = importBuffer.duration;
    $('trimDuration').textContent = `${(trimEnd - trimStart).toFixed(3)} s selecionados`;
    const maxPan = Math.max(0, importBuffer.duration - viewSpan);
    viewStart = Math.max(0, Math.min(maxPan, viewStart));
    $('timelinePan').max = maxPan; $('timelinePan').value = viewStart; $('timelinePan').disabled = !maxPan;
    $('zoomOut').disabled = viewSpan >= importBuffer.duration;
    $('zoomIn').disabled = viewSpan <= Math.min(.05, importBuffer.duration);
    drawTimeline();
  }
  function drawTimeline() {
    if (!importBuffer || !timelinePeaks || $('trimPanel').hidden) return;
    const canvas = $('timeline'), rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = window.devicePixelRatio || 1, w = rect.width, h = rect.height;
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const g = canvas.getContext('2d'); g.scale(scale, scale); g.clearRect(0, 0, w, h);
    const x = time => (time - viewStart) / viewSpan * w, mid = (h - 22) / 2;
    g.fillStyle = '#7ae6c126'; g.fillRect(x(trimStart), 0, x(trimEnd) - x(trimStart), h - 20);
    g.strokeStyle = '#7ae6c1'; g.beginPath();
    for (let px = 0; px < w; px++) {
      const first = Math.floor((viewStart + px / w * viewSpan) * importBuffer.sampleRate / 256);
      const last = Math.ceil((viewStart + (px + 1) / w * viewSpan) * importBuffer.sampleRate / 256);
      let peak = 0; for (let i = first; i < Math.min(timelinePeaks.length, Math.max(first + 1, last)); i++) peak = Math.max(peak, timelinePeaks[i]);
      g.moveTo(px, mid - peak * mid); g.lineTo(px, mid + peak * mid);
    }
    g.stroke(); g.fillStyle = '#eaf1f4';
    for (const edge of [trimStart, trimEnd]) { const px = x(edge); if (px >= 0 && px <= w) { g.fillRect(Math.min(w - 3, Math.max(0, px - 1.5)), 0, 3, h - 20); } }
    g.font = '10px sans-serif'; g.fillStyle = '#9bacb9';
    for (let i = 0; i <= 4; i++) { g.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; g.fillText(`${(viewStart + viewSpan * i / 4).toFixed(2)} s`, w * i / 4, h - 5); }
  }
  function zoomTimeline(factor) {
    if (!importBuffer || busy) return;
    const center = (trimStart + trimEnd) / 2;
    viewSpan = Math.max(Math.min(.05, importBuffer.duration), Math.min(importBuffer.duration, viewSpan * factor));
    viewStart = center - viewSpan / 2; updateTrim();
  }
  $('zoomIn').onclick = () => zoomTimeline(.5); $('zoomOut').onclick = () => zoomTimeline(2);
  $('zoomFit').onclick = () => { if (importBuffer && !busy) { viewSpan = importBuffer.duration; viewStart = 0; updateTrim(); } };
  $('timelinePan').oninput = () => { if (!busy) { viewStart = +$('timelinePan').value; drawTimeline(); } };
  $('trimStart').oninput = () => {
    if (!importBuffer || busy) return;
    stopTrimPreview();
    const value = Number($('trimStart').value); if (!Number.isFinite(value)) return updateTrim();
    const duration = trimEnd - trimStart;
    trimStart = Math.max(0, Math.min(importBuffer.duration - 1 / importBuffer.sampleRate, value));
    trimEnd = Math.min(importBuffer.duration, Math.max(trimStart + 1 / importBuffer.sampleRate, trimStart + Math.min(10, duration)));
    viewStart = (trimStart + trimEnd - viewSpan) / 2; updateTrim();
  };
  $('trimEnd').oninput = () => {
    if (!importBuffer || busy) return;
    stopTrimPreview();
    const value = Number($('trimEnd').value); if (!Number.isFinite(value)) return updateTrim();
    trimEnd = Math.min(importBuffer.duration, Math.max(trimStart + 1 / importBuffer.sampleRate, Math.min(value, trimStart + 10)));
    updateTrim();
  };
  $('trimStart').onblur = () => { $('trimStart').value = trimStart.toFixed(3); updateTrim(); };
  $('trimEnd').onblur = () => { $('trimEnd').value = trimEnd.toFixed(3); updateTrim(); };
  function pointerTime(e) { const rect = $('timeline').getBoundingClientRect(); return Math.max(0, Math.min(importBuffer.duration, viewStart + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * viewSpan)); }
  $('timeline').onpointerdown = e => {
    if (!importBuffer || busy) return;
    stopTrimPreview();
    const time = pointerTime(e), tolerance = viewSpan * 12 / $('timeline').getBoundingClientRect().width;
    const edge = Math.abs(time - trimStart) <= tolerance ? 'start' : Math.abs(time - trimEnd) <= tolerance ? 'end' : 'new';
    trimDrag = { edge, anchor:time }; $('timeline').setPointerCapture(e.pointerId);
    if (edge === 'new') { trimStart = Math.min(time, importBuffer.duration - 1 / importBuffer.sampleRate); trimEnd = Math.min(importBuffer.duration, trimStart + Math.min(10, viewSpan / 4)); updateTrim(); }
  };
  $('timeline').onpointermove = e => {
    if (!trimDrag || !importBuffer || busy) return;
    const time = pointerTime(e), min = 1 / importBuffer.sampleRate;
    if (trimDrag.edge === 'start') trimStart = Math.max(0, trimEnd - 10, Math.min(time, trimEnd - min));
    else if (trimDrag.edge === 'end') trimEnd = Math.min(importBuffer.duration, trimStart + 10, Math.max(time, trimStart + min));
    else { trimStart = Math.min(trimDrag.anchor, time, importBuffer.duration - min); trimEnd = Math.min(importBuffer.duration, trimStart + 10, Math.max(trimStart + min, trimDrag.anchor, time)); }
    updateTrim();
  };
  $('timeline').onpointerup = $('timeline').onpointercancel = () => { trimDrag = null; };
  new ResizeObserver(drawTimeline).observe($('timeline'));
  async function prepareSelection(buffer, start, end) {
    const first = Math.floor(start * buffer.sampleRate), last = Math.min(buffer.length, first + Math.floor(10 * buffer.sampleRate), Math.max(first + 1, Math.round(end * buffer.sampleRate)));
    const length = last - first, offline = new OfflineAudioContext(1, Math.min(10 * SR, Math.max(1, Math.round(length / buffer.sampleRate * SR))), SR);
    const mono = offline.createBuffer(1, length, buffer.sampleRate), data = mono.getChannelData(0);
    for (let c = 0; c < buffer.numberOfChannels; c++) { const channel = buffer.getChannelData(c); for (let i = 0; i < length; i++) data[i] += channel[first + i] / buffer.numberOfChannels; }
    const source = offline.createBufferSource(); source.buffer = mono; source.connect(offline.destination); source.start();
    return offline.startRendering();
  }
  $('file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
  $('root').onchange = () => { if (busy) ++loadId; invalidate(true); busy = false; activeRoot = +$('root').value; $('analyze').disabled = !original && !timelinePeaks; keyboard(); status(original || timelinePeaks ? 'Fundamental alterada. Confira o trecho e analise novamente.' : 'Importe uma amostra para começar.'); };
  $('analyze').onclick = async () => {
    if ((!original && !timelinePeaks) || busy) return;
    const generation = loadId;
    try {
      stopTrimPreview(); busy = true; $('analyze').disabled = true;
      await audio(); if (generation !== loadId) return;
      if (importBuffer) {
        const start = trimStart, end = trimEnd;
        status('Preparando o trecho selecionado…');
        const selected = await prepareSelection(importBuffer, start, end); if (generation !== loadId) return;
        original = selected; $('fileName').textContent = `${sourceName} · trecho ${start.toFixed(3)}–${end.toFixed(3)} s · mono`;
      }
      invalidate(); busy = true; $('original').disabled = false; $('analyze').disabled = true; activeRoot = +$('root').value; resetWorker();
      const samples = original.getChannelData(0).slice(); worker.postMessage({ type: 'analyze', samples, root: activeRoot }, [samples.buffer]);
      status('Iniciando análise…');
    } catch (e) { if (generation === loadId) { busy = false; $('analyze').disabled = !original && !timelinePeaks; status(e.message); } }
  };
  $('amount').oninput = () => {
    if (isSavedInstrument || saving) { $('amount').value = library.get(activeId)?.percent ?? $('amount').value; return; }
    clearTimeout(debounce); request++; stop(); clearNoteBank(); worker?.terminate(); worker = null;
    deepRunning = true; synthesized = rawSynth = null; deepSummary = null; playbackReady(false);
    $('percent').value = $('amount').value + '%';
    $('selected').textContent = Math.ceil((model?.total || 0) * +$('amount').value / 100).toLocaleString('pt-BR');
    draw(); processing('Aguardando seleção de parciais…', 0); updateInstrumentUI(); debounce = setTimeout(rebuild, 250);
  };
  function recoverDeep(message) {
    if (!deepRunning) return;
    deepRunning = false; worker?.terminate(); worker = null; clearNoteBank(); playbackReady(false); updateInstrumentUI();
    processing(message + ' Altere os parciais para tentar novamente.', 0);
  }
  $('original').onclick = () => { stop(); play(original, activeRoot, 'preview'); };
  $('resynth').onclick = () => { stop(); play(synthesized, activeRoot, 'preview'); };
  $('stop').onclick = stop;
  $('volume').oninput = () => { if (master) master.gain.setTargetAtTime(+$('volume').value / 100 * .6, ctx.currentTime, .02); };
  $('download').onclick = () => {
    if (!rawSynth) return;
    const buffer = new ArrayBuffer(44 + rawSynth.length * 2), v = new DataView(buffer);
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); v.setUint32(4, 36 + rawSynth.length * 2, true); text(8, 'WAVE'); text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, rawSynth.length * 2, true);
    rawSynth.forEach((s, i) => v.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 32768 : 32767)), true));
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })), a = document.createElement('a'); a.href = url; a.download = `spectral-resynth-${name(activeRoot).replace('♯', 'sharp')}-${$('amount').value}pct.wav`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  $('midi').onclick = async () => {
    try {
      await audio();
      if (!navigator.requestMIDIAccess) throw new Error('Web MIDI indisponível. Use Chrome ou Edge em localhost/HTTPS, ou o teclado da tela.');
      if (!midiAccess) midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      const connect = () => {
        stop(); const inputs = [...midiAccess.inputs.values()].filter(i => i.state === 'connected');
        for (const input of inputs) input.onmidimessage = ({ data }) => {
          const [command, note, velocity] = data, type = command & 0xf0, id = `${input.id}:${command & 15}:${note}`;
          if (type === 0x90 && velocity > 0) play(synthesized, note, id, velocity);
          else if (type === 0x80 || (type === 0x90 && velocity === 0)) release(id);
          else if (type === 0xb0 && [120, 123].includes(note)) stop();
        };
        $('midiStatus').textContent = inputs.length ? `MIDI conectado: ${inputs.map(i => i.name || 'Teclado').join(', ')}. Canal livre; sustain não implementado.` : 'MIDI ativado. Conecte seu teclado para tocar.';
      };
      midiAccess.onstatechange = connect; connect(); $('midi').textContent = 'MIDI ativado';
    } catch (e) { $('midiStatus').textContent = e.message; status(e.message); }
  };
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', () => { stop(); worker?.terminate(); clearNoteBank(); stopTelemetry(); });
  window.addEventListener('pageshow', startTelemetry);
  new ResizeObserver(draw).observe($('spectrum'));
  keyboard(); draw(); openLibrary(); startTelemetry();
})();
