/* Spectral Resynth — standalone, dependency-free prototype.
 * Analysis and synthesis run in a Worker built from this same file.
 * No network requests, libraries, or external assets are required.
 */
'use strict';

function spectralWorker() {
  const N = 4096, HOP = 256, SR = 48000, TAU = 2 * Math.PI;
  let model = null, revision = 0;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const report = (text, value) => self.postMessage({ type: 'progress', text, value });
  function fft(real, imag) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
    }
    for (let size = 2; size <= n; size *= 2) {
      const angle = -TAU / size, wr = Math.cos(angle), wi = Math.sin(angle);
      for (let start = 0; start < n; start += size) {
        let ur = 1, ui = 0;
        for (let j = 0; j < size / 2; j++) {
          const a = start + j, b = a + size / 2;
          const tr = ur * real[b] - ui * imag[b], ti = ur * imag[b] + ui * real[b];
          real[b] = real[a] - tr; imag[b] = imag[a] - ti;
          real[a] += tr; imag[a] += ti;
          const next = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = next;
        }
      }
    }
  }
  async function analyze(samples, root, token) {
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
      if (frame % 32 === 0) { report('Analisando picos e trajetórias…', frame / frames * 100); await pause(); if (token !== revision) return; }
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
  async function render(percent, request, token) {
    if (!model) throw new Error('Analise uma amostra primeiro.');
    const { tracks, length } = model;
    const count = tracks.length ? Math.max(1, Math.ceil(tracks.length * Math.max(25, Math.min(100, percent)) / 100)) : 0;
    const result = new Float32Array(length), dt = HOP / SR;
    for (let index = 0; index < count; index++) {
      const points = tracks[index].points;
      for (let j = -1; j < points.length; j++) {
        // One-hop birth/death ramps avoid clicks at track boundaries.
        const first = points[0], last = points[points.length - 1];
        const a = j < 0 ? { ...first, frame: first.frame - 1, amplitude: 0, phase: first.phase - TAU * first.frequency * dt } : points[j];
        const b = j + 1 >= points.length ? { ...last, frame: last.frame + 1, amplitude: 0, phase: last.phase + TAU * last.frequency * dt } : points[j + 1];
        const start = a.frame * HOP, end = b.frame * HOP, span = end - start;
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
      if (index % 12 === 0) { report('Reconstruindo com senoides…', index / Math.max(1, count) * 100); await pause(); if (token !== revision) return; }
    }
    let peak = 0;
    for (const sample of result) peak = Math.max(peak, Math.abs(sample));
    const gain = peak > .98 ? .98 / peak : 1;
    const fade = Math.min(240, Math.floor(length / 2));
    for (let n = 0; n < length; n++) result[n] *= gain * Math.min(1, n / Math.max(1, fade), (length - 1 - n) / Math.max(1, fade));
    if (token === revision) self.postMessage({ type: 'rendered', request, count, samples: result, gain }, [result.buffer]);
  }
  self.onmessage = async ({ data }) => {
    const token = ++revision;
    try {
      if (data.type === 'analyze') { model = null; await analyze(data.samples, data.root, token); }
      else if (data.type === 'render') await render(data.percent, data.request, token);
    } catch (error) { if (token === revision) self.postMessage({ type: 'error', message: error.message }); }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { spectralWorker };
if (typeof document !== 'undefined') (() => {
  const $ = id => document.getElementById(id), SR = 48000;
  const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const name = n => noteNames[n % 12] + (Math.floor(n / 12) - 1);
  let ctx, master, worker, original, synthesized, rawSynth, model, request = 0, loadId = 0, debounce;
  let midiAccess, voices = new Map(), pending = new Map(), busy = false, activeRoot = 48;
  const status = (text, value = 0) => { $('status').textContent = text; $('progress').value = value; };
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
    }
    await ctx.resume(); return ctx;
  }
  function playbackReady(ready) { $('resynth').disabled = $('download').disabled = !ready; document.querySelectorAll('.key').forEach(k => k.disabled = !ready); }
  function release(id) {
    pending.delete(id);
    const voice = voices.get(id); if (!voice || !ctx) return;
    voice.gain.gain.cancelScheduledValues(ctx.currentTime); voice.gain.gain.setTargetAtTime(0, ctx.currentTime, .018);
    voice.source.stop(ctx.currentTime + .1); voices.delete(id); voice.key?.classList.remove('active');
  }
  function stop() { pending.clear(); for (const id of [...voices.keys()]) release(id); }
  async function play(buffer, note, id, velocity = 100, key) {
    try {
      if (!buffer) return;
      const generation = request;
      const ticket = {}; pending.set(id, ticket);
      await audio();
      if (generation !== request || pending.get(id) !== ticket) return;
      release(id); if (voices.size >= 8) release(voices.keys().next().value);
      const source = ctx.createBufferSource(), gain = ctx.createGain(); source.buffer = buffer;
      source.playbackRate.value = 2 ** ((note - activeRoot) / 12);
      gain.gain.setValueAtTime(0, ctx.currentTime); gain.gain.linearRampToValueAtTime(velocity / 127 * .65, ctx.currentTime + .006);
      source.connect(gain); gain.connect(master); const voice = { source, gain, key }; voices.set(id, voice); key?.classList.add('active');
      source.onended = () => { source.disconnect(); gain.disconnect(); if (voices.get(id) === voice) { voices.delete(id); key?.classList.remove('active'); } };
      source.start();
    } catch (e) { status(e.message); }
  }
  function keyboard() {
    $('keys').replaceChildren();
    const base = Math.floor(+$('root').value / 12) * 12;
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
    const canvas = $('spectrum'), g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    g.fillStyle = '#060d14'; g.fillRect(0, 0, w, h);
    const left = 64, top = 16, pw = w - left - 20, ph = h - 48;
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
    g.font = '14px Segoe UI, sans-serif'; g.fillStyle = '#a1b3c0'; g.strokeStyle = '#8296aa22';
    for (const f of [50, 100, 500, 1000, 5000, 10000]) {
      const y = top + Math.log(20000 / f) / Math.log(1000) * ph;
      g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 12, y + 4); g.beginPath(); g.moveTo(left, y); g.lineTo(w - 20, y); g.stroke();
    }
    if (model) for (let i = 0; i <= 4; i++) g.fillText(`${(model.duration * i / 4).toFixed(1)} s`, left + pw * i / 4 - (i === 4 ? 30 : 0), h - 8);
  }
  function resetWorker() {
    worker?.terminate();
    const url = URL.createObjectURL(new Blob([`(${spectralWorker.toString()})();`], { type: 'text/javascript' }));
    worker = new Worker(url); URL.revokeObjectURL(url);
    worker.onerror = e => { busy = false; $('analyze').disabled = !original; status(`Falha no processamento: ${e.message || 'tente analisar novamente.'}`); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') status(data.text, data.value);
      if (data.type === 'error') { busy = false; $('analyze').disabled = !original; status(data.message); }
      if (data.type === 'analyzed') {
        model = data; busy = false; $('analyze').disabled = false; $('total').textContent = data.total.toLocaleString('pt-BR');
        $('amount').disabled = !data.total; $('empty').style.display = 'none'; $('duration').textContent = `${data.duration.toFixed(2)} s`;
        draw();
        if (data.total) rebuild(); else status('Nenhum parcial válido encontrado. Experimente uma nota mais longa ou com mais volume.', 100);
      }
      if (data.type === 'rendered' && data.request === request) {
        rawSynth = data.samples; synthesized = ctx.createBuffer(1, rawSynth.length, SR); synthesized.copyToChannel(rawSynth, 0);
        $('selected').textContent = data.count.toLocaleString('pt-BR'); playbackReady(true);
        status(`Reconstrução pronta · ${data.count.toLocaleString('pt-BR')} parciais${data.gain < 1 ? ' · pico atenuado para evitar saturação' : ''}.`, 100);
      }
    };
  }
  function invalidate() {
    clearTimeout(debounce); request++; busy = false; stop(); worker?.terminate(); worker = null;
    synthesized = rawSynth = model = null; playbackReady(false); $('amount').disabled = true;
    $('selected').textContent = $('total').textContent = '—'; $('empty').style.display = 'flex'; $('duration').textContent = 'Tempo →'; draw();
  }
  async function loadFile(file) {
    if (!file) return;
    const id = ++loadId; invalidate(); original = null; $('original').disabled = $('analyze').disabled = true;
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('Use um arquivo de até 100 MB.');
      status('Decodificando áudio…'); await audio();
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      const duration = Math.min(15, decoded.duration);
      if (duration <= 0) throw new Error('O arquivo não contém áudio.');
      const offline = new OfflineAudioContext(1, Math.ceil(duration * SR), SR), src = offline.createBufferSource();
      // Explicit arithmetic mono downmix for predictable channel weighting.
      const mono = offline.createBuffer(1, Math.min(decoded.length, Math.ceil(duration * decoded.sampleRate)), decoded.sampleRate);
      const data = mono.getChannelData(0);
      for (let c = 0; c < decoded.numberOfChannels; c++) { const ch = decoded.getChannelData(c); for (let i = 0; i < data.length; i++) data[i] += ch[i] / decoded.numberOfChannels; }
      src.buffer = mono; src.connect(offline.destination); src.start();
      const buffer = await offline.startRendering(); if (id !== loadId) return;
      original = buffer; $('fileName').textContent = `${file.name} · ${duration.toFixed(2)} s · mono${decoded.duration > 15 ? ' · primeiros 15 s (recortado)' : ''}`;
      $('original').disabled = $('analyze').disabled = false; activeRoot = +$('root').value;
      status('Amostra carregada. Confira a fundamental e clique em Analisar amostra.');
    } catch (e) { if (id === loadId) status(`Não foi possível abrir o áudio: ${e.message}`); }
  }
  function rebuild() {
    if (!model?.total) return;
    clearTimeout(debounce); stop(); synthesized = null; rawSynth = null; playbackReady(false);
    const id = ++request;
    $('selected').textContent = Math.ceil(model.total * +$('amount').value / 100).toLocaleString('pt-BR'); draw();
    worker.postMessage({ type: 'render', percent: +$('amount').value, request: id });
  }
  $('file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
  $('demo').onclick = async () => {
    const id = ++loadId; invalidate(); original = null; $('original').disabled = $('analyze').disabled = true;
    try {
      await audio(); if (id !== loadId) return;
      $('root').value = '48'; activeRoot = 48; original = ctx.createBuffer(1, SR * 3, SR);
      const samples = original.getChannelData(0), f = 440 * 2 ** ((48 - 69) / 12);
      for (let i = 0; i < samples.length; i++) { const t = i / SR; let s = 0; for (let h = 1; h <= 12; h++) s += Math.cos(2 * Math.PI * f * h * t) / h ** 1.3 * Math.exp(-t * (.7 + h * .12)); samples[i] = .45 * Math.min(1, t / .012) * Math.min(1, (3 - t) / .1) * s; }
      $('fileName').textContent = 'Demonstração · C3 · 12 harmônicos · 3 s'; $('original').disabled = $('analyze').disabled = false; keyboard(); $('analyze').click();
    } catch (e) { status(e.message); }
  };
  $('root').onchange = () => { invalidate(); busy = false; activeRoot = +$('root').value; $('analyze').disabled = !original; keyboard(); status(original ? 'Fundamental alterada. Analise novamente para atualizar a seleção.' : 'Importe uma amostra para começar.'); };
  $('analyze').onclick = async () => {
    if (!original || busy) return;
    try {
      await audio(); invalidate(); busy = true; $('analyze').disabled = true; activeRoot = +$('root').value; resetWorker();
      const samples = original.getChannelData(0).slice(); worker.postMessage({ type: 'analyze', samples, root: activeRoot }, [samples.buffer]);
      status('Iniciando análise…');
    } catch (e) { busy = false; $('analyze').disabled = !original; status(e.message); }
  };
  $('amount').oninput = () => {
    $('percent').value = `${$('amount').value}%`; clearTimeout(debounce); request++; stop(); synthesized = rawSynth = null; playbackReady(false);
    $('selected').textContent = Math.ceil((model?.total || 0) * +$('amount').value / 100).toLocaleString('pt-BR'); draw(); status('Atualizando a quantidade de parciais…'); debounce = setTimeout(rebuild, 160);
  };
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
    } catch (e) { $('midiStatus').textContent = e.message; }
  };
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', () => { stop(); worker?.terminate(); });
  keyboard(); draw();
})();
