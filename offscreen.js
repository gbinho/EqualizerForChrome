// Documento invisível: recebe o áudio das abas, passa pelo equalizador e toca de volta.
(() => {
  const LIMIT_DB = -1;
  const LIMIT_RATIO = 20;
  // O compressor do Chrome soma um ganho de compensação automático; o trim desfaz isso
  // para o som no plano sair com o mesmo volume do original.
  const MAKEUP_DB = 0.6 * -(LIMIT_DB - LIMIT_DB / LIMIT_RATIO);
  const SPECTRUM_BINS = 96;
  const SMOOTHING = 0.015; // segundos; evita estalos ao arrastar os sliders

  const captures = new Map(); // tabId -> { stream, chain }
  let audio = null;
  let settings = EQ.sanitize();
  let bypass = false;

  function context() {
    if (!audio || audio.state === 'closed') audio = new AudioContext({ latencyHint: 'interactive' });
    return audio;
  }

  async function start({ tabId, streamId, settings: next }) {
    if (next) settings = EQ.sanitize(next);
    if (captures.has(tabId)) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    const ctx = context();
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

  // aba -> pré-amp -> 10 filtros -> limitador -> trim -> alto-falante (+ analisador para o espectro)
  function buildChain(ctx, stream) {
    const source = ctx.createMediaStreamSource(stream);
    const preamp = ctx.createGain();
    const filters = EQ.createFilters(ctx);

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

    const nodes = [source, preamp, ...filters, limiter, trim];
    nodes.reduce((from, to) => (from.connect(to), to));
    trim.connect(ctx.destination);
    trim.connect(analyser);

    const chain = {
      ctx,
      preamp,
      filters,
      readSpectrum: spectrumReader(analyser, ctx.sampleRate),
      disconnect: () => [...nodes, analyser].forEach((n) => n.disconnect()),
    };
    apply(chain, true);
    return chain;
  }

  function apply(chain, instant = false) {
    const s = bypass ? EQ.sanitize() : settings;
    const t = chain.ctx.currentTime;
    const set = (param, value) => (instant ? (param.value = value) : param.setTargetAtTime(value, t, SMOOTHING));
    set(chain.preamp.gain, EQ.dbToGain(s.preamp));
    chain.filters.forEach((f, i) => set(f.gain, s.gains[i]));
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

  // O popup aberto numa aba equalizada recebe o espectro por aqui e usa o mesmo canal
  // para o "segure para ouvir o original". Fechou o popup, o original solta sozinho.
  chrome.runtime.onConnect.addListener((port) => {
    const match = /^spectrum:(\d+)$/.exec(port.name);
    if (!match) return;
    const tabId = Number(match[1]);
    const timer = setInterval(() => {
      const capture = captures.get(tabId);
      if (capture) port.postMessage(capture.chain.readSpectrum());
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
