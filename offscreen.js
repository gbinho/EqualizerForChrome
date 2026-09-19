// Documento invisível: recebe o áudio das abas, passa pelo equalizador e toca de volta.
(() => {
  const LIMIT_DB = -1;
  const LIMIT_RATIO = 20;
  // O compressor do Chrome soma um ganho de compensação automático; o trim desfaz isso
  // para o som no plano sair com o mesmo volume do original.
  const MAKEUP_DB = 0.6 * -(LIMIT_DB - LIMIT_DB / LIMIT_RATIO);
  const SPECTRUM_BINS = 96;
  const SMOOTHING = 0.015;      // segundos; evita estalos ao arrastar os sliders
  const AMBIENCE_WIDTH = 0.7;   // quanto o estéreo abre no máximo
  const AMBIENCE_WET = 0.45;    // quanto de reverberação entra no máximo
  const REVERB_SECONDS = 2.2;
  const REVERB_FLOOR = 250;     // Hz; abaixo disso a reverberação não entra, e o grave fica firme
  const VOICE_LOW = 200;        // Hz; faixa onde a voz vive, usada para isolar voz/beat
  const VOICE_HIGH = 9000;

  // Quanto cada caminho do centro e das laterais entra em cada modo de isolamento:
  // [centro inteiro, centro grave, centro agudo, centro na faixa da voz, laterais]
  const SEPARATION = {
    off: [1, 0, 0, 0, 1],
    beat: [0, 1, 1, 0, 1],  // tira o centro na faixa da voz; grave e brilho continuam
    vocal: [0, 0, 0, 1, 0], // fica só o centro na faixa da voz
  };

  const captures = new Map(); // tabId -> { stream, chain }
  let audio = null;
  let workletReady = null;
  let impulse = null;
  let settings = EQ.sanitize();
  let bypass = false;

  function context() {
    if (!audio || audio.state === 'closed') {
      audio = new AudioContext({ latencyHint: 'interactive' });
      workletReady = null;
      impulse = null;
    }
    return audio;
  }

  function ensureWorklet(ctx) {
    workletReady ||= ctx.audioWorklet.addModule('pitch-processor.js');
    return workletReady;
  }

  async function start({ tabId, streamId, settings: next }) {
    if (next) settings = EQ.sanitize(next);
    if (captures.has(tabId)) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    const ctx = context();
    await ensureWorklet(ctx);
    if (ctx.state !== 'running') await ctx.resume();
    captures.set(tabId, { stream, chain: buildChain(ctx, stream) });
    // A faixa termina sozinha quando a aba fecha ou outra coisa interrompe a captura.
    for (const track of stream.getTracks()) track.addEventListener('ended', () => stop(tabId));
    report();
  }

  function stop(tabId) {
    const capture = captures.get(tabId);
    if (!capture) return;
    captures.delete(tabId);
    capture.stream.getTracks().forEach((t) => t.stop());
    capture.chain.disconnect();
    if (!captures.size && audio) audio.suspend();
    report();
  }

  // aba -> pré-amp -> 10 filtros -> tom -> isolar -> ambiência -> nivelador -> limitador -> alto-falante
  function buildChain(ctx, stream) {
    const source = ctx.createMediaStreamSource(stream);
    const preamp = ctx.createGain();
    const filters = EQ.createFilters(ctx);

    const pitch = new AudioWorkletNode(ctx, 'pitch-processor', {
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    const separator = buildSeparator(ctx);
    const ambience = buildAmbience(ctx);

    // Nivelador: em 0 fica transparente (razão 1 não comprime nada).
    const leveler = ctx.createDynamicsCompressor();
    leveler.threshold.value = -2;
    leveler.knee.value = 12;
    leveler.ratio.value = 1;
    leveler.attack.value = 0.02;
    leveler.release.value = 0.35;
    const levelMakeup = ctx.createGain();

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = LIMIT_RATIO;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    const trim = ctx.createGain();
    trim.gain.value = EQ.dbToGain(-MAKEUP_DB);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -20;

    const line = [source, preamp, ...filters, pitch, separator.input];
    line.reduce((from, to) => (from.connect(to), to));
    separator.output.connect(ambience.input);
    ambience.output.connect(leveler);
    leveler.connect(levelMakeup);
    levelMakeup.connect(limiter);
    limiter.connect(trim);
    trim.connect(ctx.destination);
    trim.connect(analyser);

    const chain = {
      ctx,
      preamp,
      filters,
      ratio: pitch.parameters.get('ratio'),
      separator,
      ambience,
      leveler,
      levelMakeup,
      limiter,
      readSpectrum: spectrumReader(analyser, ctx.sampleRate),
      disconnect: () => {
        [...line, leveler, levelMakeup, limiter, trim, analyser].forEach((n) => n.disconnect());
        separator.disconnect();
        ambience.disconnect();
      },
    };
    apply(chain, true);
    return chain;
  }

  // Separa o que está no centro (voz, quase sempre) do que está espalhado (instrumentos),
  // e trata o centro por faixa de frequência: grave e brilho podem ficar mesmo sem a voz.
  function buildSeparator(ctx) {
    const { input, splitter, mid, side, merger, output, nodes } = midSide(ctx);

    const full = ctx.createGain();
    const lowPath = ctx.createBiquadFilter();
    lowPath.type = 'lowpass';
    lowPath.frequency.value = VOICE_LOW;
    const low = ctx.createGain();
    const highPath = ctx.createBiquadFilter();
    highPath.type = 'highpass';
    highPath.frequency.value = VOICE_HIGH;
    const high = ctx.createGain();
    const bandLow = ctx.createBiquadFilter();
    bandLow.type = 'highpass';
    bandLow.frequency.value = VOICE_LOW;
    const bandHigh = ctx.createBiquadFilter();
    bandHigh.type = 'lowpass';
    bandHigh.frequency.value = VOICE_HIGH;
    const band = ctx.createGain();
    low.gain.value = 0;
    high.gain.value = 0;
    band.gain.value = 0;

    mid.connect(full);
    mid.connect(lowPath).connect(low);
    mid.connect(highPath).connect(high);
    mid.connect(bandLow).connect(bandHigh).connect(band);
    for (const path of [full, low, high, band]) {
      path.connect(merger, 0, 0);
      path.connect(merger, 0, 1);
    }

    const extra = [full, lowPath, low, highPath, high, bandLow, bandHigh, band];
    return {
      input, output, full, low, high, band, side,
      disconnect: () => [...nodes, ...extra].forEach((n) => n.disconnect()),
    };
  }

  // Ambiência 3D: abre o estéreo e soma uma reverberação gerada aqui mesmo.
  function buildAmbience(ctx) {
    const { input, mid, side, merger, output, nodes } = midSide(ctx);
    mid.connect(merger, 0, 0);
    mid.connect(merger, 0, 1);

    const send = ctx.createBiquadFilter();
    send.type = 'highpass';
    send.frequency.value = REVERB_FLOOR;
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse ||= buildImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0;

    merger.connect(send);
    send.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);

    const extra = [send, convolver, wet];
    return { input, output, side, wet, disconnect: () => [...nodes, ...extra].forEach((n) => n.disconnect()) };
  }

  // Base compartilhada: separa centro (mid) e laterais (side) e junta de volta em estéreo.
  // Quem chama decide o que fazer com o centro antes de ligá-lo ao merger.
  function midSide(ctx) {
    const input = ctx.createGain();
    // Força dois canais: em som mono o lado fica zerado, e mexer no estéreo não joga tudo para um lado.
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = 'explicit';
    stereo.channelInterpretation = 'speakers';

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const midLeft = ctx.createGain();
    const midRight = ctx.createGain();
    const sideLeft = ctx.createGain();
    const sideRight = ctx.createGain();
    const mid = ctx.createGain();
    const side = ctx.createGain();
    const sideInverted = ctx.createGain();
    const output = ctx.createGain();
    midLeft.gain.value = 0.5;
    midRight.gain.value = 0.5;
    sideLeft.gain.value = 0.5;
    sideRight.gain.value = -0.5;
    sideInverted.gain.value = -1;

    input.connect(stereo);
    stereo.connect(splitter);
    splitter.connect(midLeft, 0);
    splitter.connect(midRight, 1);
    splitter.connect(sideLeft, 0);
    splitter.connect(sideRight, 1);
    midLeft.connect(mid);
    midRight.connect(mid);
    sideLeft.connect(side);
    sideRight.connect(side);
    side.connect(sideInverted);
    side.connect(merger, 0, 0);
    sideInverted.connect(merger, 0, 1);
    merger.connect(output);

    const nodes = [input, stereo, splitter, midLeft, midRight, sideLeft, sideRight,
      mid, side, sideInverted, merger, output];
    return { input, splitter, mid, side, merger, output, nodes };
  }

  // Reverberação gerada no próprio código: ruído que decai, suavizado para soar como sala, não como chiado.
  function buildImpulse(ctx) {
    const length = Math.floor(ctx.sampleRate * REVERB_SECONDS);
    const preDelay = Math.floor(ctx.sampleRate * 0.02);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let smoothed = 0;
      for (let i = 0; i < length; i++) {
        smoothed = smoothed * 0.55 + (Math.random() * 2 - 1) * 0.45;
        const t = i / length;
        data[i] = i < preDelay ? 0 : smoothed * Math.pow(1 - t, 2.8);
      }
    }
    return buffer;
  }

  function apply(chain, instant = false) {
    const s = bypass ? EQ.sanitize() : settings;
    const t = chain.ctx.currentTime;
    const set = (param, value) => (instant ? (param.value = value) : param.setTargetAtTime(value, t, SMOOTHING));
    set(chain.preamp.gain, EQ.dbToGain(s.preamp));
    chain.filters.forEach((f, i) => set(f.gain, s.gains[i]));

    // O tom desliza um pouco mais devagar, então a mudança soa como um deslize e não como um corte.
    const ratio = EQ.semitonesToRatio(s.pitch);
    if (instant) chain.ratio.value = ratio;
    else chain.ratio.setTargetAtTime(ratio, t, 0.04);

    const [full, low, high, band, side] = SEPARATION[s.separate] || SEPARATION.off;
    set(chain.separator.full.gain, full);
    set(chain.separator.low.gain, low);
    set(chain.separator.high.gain, high);
    set(chain.separator.band.gain, band);
    set(chain.separator.side.gain, side);

    const amount = s.ambience / 100;
    set(chain.ambience.side.gain, 1 + AMBIENCE_WIDTH * amount);
    set(chain.ambience.wet.gain, AMBIENCE_WET * amount);

    const level = s.level / 100;
    set(chain.leveler.ratio, 1 + 3 * level);
    set(chain.leveler.threshold, -2 - 28 * level);
    set(chain.levelMakeup.gain, EQ.dbToGain(8 * level));
  }

  const applyAll = () => captures.forEach(({ chain }) => apply(chain));

  function setBypass(on) {
    if (bypass === on) return;
    bypass = on;
    applyAll();
  }

  // Agrupa as barras da FFT em faixas logarítmicas alinhadas às colunas do gráfico do popup.
  function spectrumReader(analyser, sampleRate) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const hzPerBin = sampleRate / analyser.fftSize;
    const ranges = Array.from({ length: SPECTRUM_BINS }, (_, k) => {
      const lo = Math.floor(EQ.xToFreq(k / SPECTRUM_BINS) / hzPerBin);
      const hi = Math.ceil(EQ.xToFreq((k + 1) / SPECTRUM_BINS) / hzPerBin);
      const a = EQ.clamp(lo, 1, data.length - 1);
      return [a, EQ.clamp(hi, a + 1, data.length)];
    });
    return () => {
      analyser.getByteFrequencyData(data);
      return ranges.map(([a, b]) => {
        let peak = 0;
        for (let i = a; i < b; i++) if (data[i] > peak) peak = data[i];
        return peak;
      });
    };
  }

  const tabIds = () => [...captures.keys()];

  function report() {
    chrome.runtime.sendMessage({ target: 'background', type: 'captures', tabIds: tabIds() }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return;
    switch (msg.type) {
      case 'start':
        start(msg).then(
          () => sendResponse({ ok: true, tabIds: tabIds() }),
          (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
        );
        return true;
      case 'stop':
        stop(msg.tabId);
        sendResponse({ ok: true, tabIds: tabIds() });
        return;
      case 'settings':
        settings = EQ.sanitize(msg.settings);
        applyAll();
        return;
    }
  });

  // O popup aberto numa aba equalizada recebe o espectro e o quanto o limitador está segurando.
  // O mesmo canal leva o "segure para ouvir o original": fechou o popup, o original solta sozinho.
  chrome.runtime.onConnect.addListener((port) => {
    const match = /^spectrum:(\d+)$/.exec(port.name);
    if (!match) return;
    const tabId = Number(match[1]);
    const timer = setInterval(() => {
      const capture = captures.get(tabId);
      if (capture) port.postMessage({ s: capture.chain.readSpectrum(), r: capture.chain.limiter.reduction });
    }, 1000 / 30);
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'bypass') setBypass(!!msg.on);
    });
    port.onDisconnect.addListener(() => {
      clearInterval(timer);
      setBypass(false);
    });
  });
})();
