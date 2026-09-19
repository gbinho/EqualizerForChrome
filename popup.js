// Popup: liga o equalizador na aba atual, ajusta as bandas e desenha curva + espectro.
(() => {
  const { BANDS, LABELS, RANGE, PRESETS, SPEED } = EQ;
  const PAD = 8;       // respiro vertical do gráfico (igual a --pad no CSS)
  const THUMB = 14;    // diâmetro da bolinha do slider (igual a --thumb no CSS)
  const POINTS = 240;  // resolução da curva
  const MORPH_MS = 240; // transição da curva ao trocar de preset
  const ACCENT = [255, 106, 26];
  const rgba = (a) => `rgba(${ACCENT.join(',')},${a})`;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const $ = (id) => document.getElementById(id);
  const el = {
    power: $('power'), powerLabel: $('power-label'), status: $('status'), statusText: $('status-text'),
    graph: $('graph'), canvas: $('canvas'), bands: $('bands'), hint: $('hint'), scale: $('scale'),
    preamp: $('preamp'), preampValue: $('preamp-value'),
    presetsHead: $('presets-head'), chips: $('chips'), save: $('save'), remove: $('delete'),
    saveForm: $('save-form'), saveName: $('save-name'), saveCancel: $('save-cancel'),
    effects: $('effects'), effectsSummary: $('effects-summary'), effectsNote: $('effects-note'),
    speed: $('speed'), speedValue: $('speed-value'),
    pitch: $('pitch'), pitchValue: $('pitch-value'),
    ambience: $('ambience'), ambienceValue: $('ambience-value'),
    ab: $('ab'),
  };

  const state = {
    tab: null,
    host: '',
    active: false,
    busy: false,
    restricted: false,
    error: '',
    bypass: false,
    settings: EQ.sanitize(),
    custom: [],
    speed: SPEED.normal, // por aba, porque quem muda a velocidade é o player da página
    speedError: '',
  };

  const bandInputs = [];
  const valueCells = [];
  let shown = state.settings.gains.slice(); // ganhos desenhados: seguem os reais, com transição nos presets
  let morph = 0;
  let port = null;
  let incoming = null; // último quadro do espectro recebido
  let spectrum = null; // quadro exibido, suavizado
  let raf = 0;
  let curve = null;    // resposta em dB, recalculada só quando os ganhos desenhados mudam
  let saveTimer = 0;
  let speedTimer = 0;

  // Filtros "de mentira" só para calcular a curva exata que o som real vai ter.
  const offline = new OfflineAudioContext(1, 1, 48000);
  const filters = EQ.createFilters(offline);
  const freqs = Float32Array.from({ length: POINTS }, (_, k) => EQ.xToFreq(k / (POINTS - 1)));
  const mag = new Float32Array(POINTS);
  const phase = new Float32Array(POINTS);

  buildBands();
  buildScale();
  bindControls();
  const graph = sizeCanvas();
  init();

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    state.restricted = !tab || isRestricted(tab.url);
    try { state.host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { state.host = ''; }

    const [local, session] = await Promise.all([
      chrome.storage.local.get(['settings', 'customPresets', 'effectsOpen']),
      chrome.storage.session.get(['activeTabs', 'speeds']),
    ]);
    state.settings = EQ.sanitize(local.settings);
    state.custom = Array.isArray(local.customPresets) ? local.customPresets : [];
    state.active = !!tab && (session.activeTabs || []).includes(tab.id);
    state.speed = EQ.speedOf(session.speeds?.[tab?.id]);
    el.effects.open = !!local.effectsOpen;

    shown = state.settings.gains.slice();
    syncBandInputs();
    el.preamp.value = state.settings.preamp;
    el.speed.value = state.speed;
    el.pitch.value = state.settings.pitch;
    el.ambience.value = state.settings.ambience;
    renderValues();
    renderChips();
    renderHeader();
    if (state.active) connectSpectrum();
    // A página pode ter recarregado desde a última vez: devolve a velocidade escolhida.
    if (state.speed !== SPEED.normal) applySpeed(state.speed);
  }

  // ---------- montagem ----------

  function buildBands() {
    BANDS.forEach((_, i) => {
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: -RANGE, max: RANGE, step: 0.5, value: 0, className: 'band' });
      input.setAttribute('aria-label', `${LABELS[i]} Hz`);
      input.addEventListener('input', () => setGain(i, Number(input.value)));
      input.addEventListener('change', saveNow);
      input.addEventListener('dblclick', () => setGain(i, 0));
      input.addEventListener('wheel', (e) => {
        e.preventDefault();
        setGain(i, state.settings.gains[i] + (e.deltaY < 0 ? 0.5 : -0.5));
      }, { passive: false });
      bandInputs.push(input);
      el.bands.append(input);
    });
  }

  function buildScale() {
    LABELS.forEach((label) => {
      const cell = document.createElement('div');
      const freq = document.createElement('span');
      const val = document.createElement('span');
      freq.className = 'freq';
      freq.textContent = label;
      val.className = 'val';
      cell.append(freq, val);
      valueCells.push(val);
      el.scale.append(cell);
    });
  }

  function sizeCanvas() {
    const w = el.graph.clientWidth;
    const h = el.graph.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    el.canvas.width = Math.round(w * dpr);
    el.canvas.height = Math.round(h * dpr);
    const ctx = el.canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w, h };
  }

  function bindControls() {
    el.power.addEventListener('click', toggle);

    el.preamp.addEventListener('input', () => {
      state.settings.preamp = Number(el.preamp.value);
      onChange();
    });
    el.preamp.addEventListener('change', saveNow);
    el.preamp.addEventListener('dblclick', () => {
      state.settings.preamp = 0;
      el.preamp.value = 0;
      onChange();
    });

    el.chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) applyPreset(chip.dataset.id);
    });

    el.save.addEventListener('click', () => {
      el.saveName.value = '';
      el.presetsHead.hidden = true;
      el.saveForm.hidden = false;
      el.saveName.focus();
    });
    el.saveCancel.addEventListener('click', closeSaveForm);
    el.saveName.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSaveForm(); }
    });
    el.saveForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveCustom(el.saveName.value.trim().slice(0, 24));
    });

    el.remove.addEventListener('click', () => {
      const name = customName(state.settings.preset);
      state.custom = state.custom.filter((c) => c.name !== name);
      state.settings.preset = null;
      chrome.storage.local.set({ customPresets: state.custom });
      renderChips();
      saveNow();
    });

    bindEffects();

    // Segurar o botão desliga o efeito só enquanto está pressionado (comparação A/B).
    el.ab.addEventListener('pointerdown', (e) => {
      if (el.ab.disabled) return;
      el.ab.setPointerCapture(e.pointerId);
      setBypass(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.ab.addEventListener(type, () => setBypass(false));
    }
    el.ab.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); setBypass(true); }
    });
    el.ab.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') setBypass(false);
    });
    window.addEventListener('blur', () => setBypass(false));
    window.addEventListener('pagehide', saveNow);
  }

  function bindEffects() {
    el.effects.addEventListener('toggle', () => chrome.storage.local.set({ effectsOpen: el.effects.open }));

    el.speed.addEventListener('input', () => {
      state.speed = EQ.speedOf(Number(el.speed.value));
      renderEffects();
      clearTimeout(speedTimer);
      speedTimer = setTimeout(() => applySpeed(state.speed), 120);
    });
    el.speed.addEventListener('change', () => { applySpeed(state.speed); saveSpeed(); });
    el.speed.addEventListener('dblclick', () => setSpeed(SPEED.normal));

    el.pitch.addEventListener('input', () => {
      state.settings.pitch = Number(el.pitch.value);
      onChange();
    });
    el.pitch.addEventListener('change', saveNow);
    el.pitch.addEventListener('dblclick', () => {
      state.settings.pitch = 0;
      el.pitch.value = 0;
      onChange();
    });

    el.ambience.addEventListener('input', () => {
      state.settings.ambience = Number(el.ambience.value);
      onChange();
    });
    el.ambience.addEventListener('change', saveNow);
    el.ambience.addEventListener('dblclick', () => {
      state.settings.ambience = 0;
      el.ambience.value = 0;
      onChange();
    });
  }

  // ---------- ações ----------

  async function toggle() {
    if (state.busy || !state.tab || state.restricted) return;
    const turningOn = !state.active;
    state.busy = true;
    state.error = '';
    renderHeader();
    const res = await chrome.runtime
      .sendMessage({ target: 'background', type: turningOn ? 'start' : 'stop', tabId: state.tab.id, settings: state.settings })
      .catch((err) => ({ ok: false, error: err?.message }));
    state.busy = false;
    if (res?.ok) state.active = turningOn;
    else state.error = friendlyError(res?.error);
    if (!state.active) state.bypass = false;
    renderHeader();
    if (state.active) connectSpectrum();
    else disconnectSpectrum();
  }

  function setGain(i, value) {
    stopMorph();
    state.settings.gains[i] = EQ.clamp(Math.round(value * 2) / 2, -RANGE, RANGE);
    shown = state.settings.gains.slice();
    syncBandInputs();
    curve = null;
    if (state.settings.preset !== null) {
      state.settings.preset = null;
      renderPresetState();
    }
    onChange();
  }

  function applyPreset(id) {
    const preset = id.startsWith('custom:')
      ? state.custom.find((c) => `custom:${c.name}` === id)
      : PRESETS.find((p) => p.id === id);
    if (!preset) return;
    // O preset mexe só no equalizador; os efeitos continuam como estavam.
    state.settings = EQ.sanitize({ ...state.settings, gains: preset.gains, preamp: preset.preamp, preset: id });
    el.preamp.value = state.settings.preamp;
    renderPresetState();
    morphTo(state.settings.gains);
    onChange();
    saveNow();
  }

  function saveCustom(name) {
    if (!name) return;
    const key = name.toLocaleLowerCase('pt-BR');
    const index = state.custom.findIndex((c) => c.name.toLocaleLowerCase('pt-BR') === key);
    const entry = {
      name: index >= 0 ? state.custom[index].name : name,
      gains: [...state.settings.gains],
      preamp: state.settings.preamp,
    };
    if (index >= 0) state.custom[index] = entry;
    else state.custom.push(entry);
    state.settings.preset = `custom:${entry.name}`;
    chrome.storage.local.set({ customPresets: state.custom });
    closeSaveForm();
    renderChips();
    saveNow();
  }

  function closeSaveForm() {
    el.saveForm.hidden = true;
    el.presetsHead.hidden = false;
  }

  function setBypass(on) {
    if (state.bypass === on || (on && !port)) return;
    state.bypass = on;
    el.ab.classList.toggle('held', on);
    port?.postMessage({ type: 'bypass', on });
    if (!raf) draw();
  }

  function onChange() {
    renderValues();
    renderEffects();
    // Vai direto para o documento que processa o som; se ninguém estiver equalizando, só é ignorado.
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'settings', settings: state.settings }).catch(() => {});
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
    if (!raf) draw();
  }

  function saveNow() {
    clearTimeout(saveTimer);
    chrome.storage.local.set({ settings: state.settings });
  }

  // ---------- velocidade: quem muda é o player da página ----------

  function setSpeed(rate) {
    state.speed = rate;
    el.speed.value = rate;
    renderEffects();
    applySpeed(rate);
    saveSpeed();
  }

  async function applySpeed(rate) {
    if (!state.tab || state.restricted) return;
    clearTimeout(speedTimer);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.tab.id, allFrames: true },
        args: [rate],
        func: (value) => {
          window.__eqSpeed = value;
          const apply = () => {
            for (const media of document.querySelectorAll('video, audio')) {
              media.preservesPitch = true; // velocidade sem deixar a voz fina; o tom tem controle próprio
              if (media.playbackRate !== window.__eqSpeed) media.playbackRate = window.__eqSpeed;
            }
          };
          apply();
          if (!window.__eqSpeedWatch) {
            window.__eqSpeedWatch = true;
            // Faixa nova ou player recriado voltam na velocidade escolhida.
            let pending = 0;
            const soon = () => { clearTimeout(pending); pending = setTimeout(apply, 250); };
            document.addEventListener('play', apply, true);
            new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
          }
        },
      });
      state.speedError = '';
    } catch {
      state.speedError = 'A velocidade não funciona nesta página';
    }
    renderEffects();
  }

  async function saveSpeed() {
    if (!state.tab) return;
    const { speeds = {} } = await chrome.storage.session.get('speeds');
    speeds[state.tab.id] = state.speed;
    chrome.storage.session.set({ speeds });
  }

  // ---------- transição entre presets ----------

  // O som muda na hora; só o desenho desliza até a curva nova, para dar para ver o que mudou.
  function morphTo(gains) {
    stopMorph();
    if (reducedMotion.matches) {
      shown = gains.slice();
      paintShown();
      return;
    }
    const from = shown.slice();
    const start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / MORPH_MS);
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      shown = from.map((g, i) => g + (gains[i] - g) * eased);
      paintShown();
      morph = t < 1 ? requestAnimationFrame(frame) : 0;
    };
    morph = requestAnimationFrame(frame);
  }

  function stopMorph() {
    cancelAnimationFrame(morph);
    morph = 0;
  }

  function paintShown() {
    syncBandInputs();
    curve = null;
    if (!raf) draw();
  }

  // ---------- espectro ao vivo ----------

  function connectSpectrum() {
    if (port || !state.tab) return;
    port = chrome.runtime.connect({ name: `spectrum:${state.tab.id}` });
    port.onMessage.addListener((frame) => {
      if (Array.isArray(frame)) incoming = frame;
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      stopLoop();
    });
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function disconnectSpectrum() {
    port?.disconnect();
    port = null;
    stopLoop();
  }

  function stopLoop() {
    cancelAnimationFrame(raf);
    raf = 0;
    incoming = spectrum = null;
    el.ab.classList.remove('held');
    draw();
  }

  function loop() {
    if (incoming) {
      spectrum ||= incoming.slice();
      for (let k = 0; k < incoming.length; k++) {
        const target = incoming[k];
        spectrum[k] += (target - spectrum[k]) * (target > spectrum[k] ? 0.55 : 0.2);
      }
    }
    draw();
    raf = requestAnimationFrame(loop);
  }

  // ---------- desenho ----------

  function yOf(db) {
    const t = (db + RANGE) / (2 * RANGE);
    return PAD + THUMB / 2 + (1 - t) * (graph.h - 2 * PAD - THUMB);
  }

  function computeCurve() {
    filters.forEach((f, i) => { f.gain.value = shown[i]; });
    const total = new Float32Array(POINTS);
    for (const f of filters) {
      f.getFrequencyResponse(freqs, mag, phase);
      for (let k = 0; k < POINTS; k++) total[k] += 20 * Math.log10(mag[k]);
    }
    return total;
  }

  function draw() {
    const { ctx, w, h } = graph;
    ctx.clearRect(0, 0, w, h);

    // grade: 0 dB mais forte, ±6 e ±12 bem discretos
    ctx.lineWidth = 1;
    for (const db of [RANGE, RANGE / 2, 0, -RANGE / 2, -RANGE]) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.045)';
      line(ctx, 0, y, w, y);
    }
    // trilho vertical de cada banda
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    for (let i = 0; i < BANDS.length; i++) {
      const x = Math.round(((i + 0.5) * w) / BANDS.length) + 0.5;
      line(ctx, x, yOf(RANGE), x, yOf(-RANGE));
    }

    if (spectrum) drawSpectrum(ctx, w, h);

    curve ||= computeCurve();
    const zero = yOf(0);
    const yAt = (k) => EQ.clamp(state.bypass ? zero : yOf(curve[k]), 1, h - 1);

    const path = new Path2D();
    for (let k = 0; k < POINTS; k++) {
      const x = (k / (POINTS - 1)) * w;
      k ? path.lineTo(x, yAt(k)) : path.moveTo(x, yAt(k));
    }

    // área entre a curva e o 0 dB
    const area = new Path2D(path);
    area.lineTo(w, zero);
    area.lineTo(0, zero);
    area.closePath();
    ctx.fillStyle = state.active ? rgba(0.1) : 'rgba(255,255,255,.035)';
    ctx.fill(area);

    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = !state.active ? 'rgba(154,154,165,.7)' : state.bypass ? 'rgba(237,237,240,.85)' : rgba(1);
    ctx.stroke(path);
  }

  function drawSpectrum(ctx, w, h) {
    const n = spectrum.length;
    const top = PAD;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let k = 0; k < n; k++) {
      const x = ((k + 0.5) / n) * w;
      const y = h - (spectrum[k] / 255) * (h - top);
      if (k === 0) ctx.lineTo(0, y);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, top, 0, h);
    gradient.addColorStop(0, rgba(0.22));
    gradient.addColorStop(1, rgba(0.03));
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  function line(ctx, x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // ---------- estado na tela ----------

  function renderHeader() {
    const { active, busy, restricted } = state;
    document.body.classList.toggle('is-active', active);
    el.power.setAttribute('aria-checked', String(active));
    el.power.disabled = busy || restricted || !state.tab;
    el.powerLabel.textContent = busy ? (active ? 'Desligando…' : 'Ligando…') : active ? 'Ligado' : 'Ligar';

    const where = state.host || 'esta aba';
    el.statusText.textContent = restricted
      ? 'Esta página não pode ser equalizada'
      : state.error || (active ? `Equalizando ${where}` : `Desligado em ${where}`);
    el.status.classList.toggle('error', !!state.error);
    el.status.title = el.statusText.textContent;

    el.hint.hidden = active;
    el.hint.textContent = restricted
      ? 'O Chrome não deixa mexer no som das páginas internas'
      : 'Ligue para ouvir o efeito nesta aba';
    el.ab.disabled = !active;
    renderEffects();
    draw();
  }

  function renderValues() {
    const { gains, preamp } = state.settings;
    gains.forEach((g, i) => {
      valueCells[i].textContent = EQ.formatDb(g);
      valueCells[i].classList.toggle('on', g !== 0);
    });
    el.preampValue.textContent = `${EQ.formatDb(preamp)} dB`;
  }

  function renderEffects() {
    const { pitch, ambience } = state.settings;
    el.speedValue.textContent = EQ.formatSpeed(state.speed);
    el.pitchValue.textContent = `${EQ.formatDb(pitch)} st`;
    el.ambienceValue.textContent = `${ambience}%`;
    el.speed.disabled = state.restricted || !state.tab;

    // O resumo aparece recolhido, então dá para ver o que está ligado sem abrir.
    const parts = [];
    if (state.speed !== SPEED.normal) parts.push(EQ.formatSpeed(state.speed));
    if (pitch !== 0) parts.push(`${EQ.formatDb(pitch)} st`);
    if (ambience > 0) parts.push(`${ambience}%`);
    el.effectsSummary.textContent = parts.join(' · ');

    const needsPower = !state.active && (pitch !== 0 || ambience > 0);
    el.effectsNote.textContent = state.speedError
      || (needsPower
        ? 'Tom e ambiência só valem com o equalizador ligado'
        : 'Velocidade muda o player da página. Tom e ambiência mudam o som capturado.');
    el.effectsNote.classList.toggle('warn', !!state.speedError);
  }

  // Os presets do usuário vêm primeiro; depois os prontos, já na ordem "mais graves primeiro".
  function renderChips() {
    const items = [
      ...state.custom.map((c) => ({ id: `custom:${c.name}`, name: c.name })),
      ...PRESETS.map((p) => ({ id: p.id, name: p.name })),
    ];
    if (!items.some((item) => item.id === state.settings.preset)) state.settings.preset = null;
    el.chips.replaceChildren(...items.map(({ id, name }) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.id = id;
      chip.textContent = name;
      return chip;
    }));
    renderPresetState();
  }

  // Atualiza só o destaque, sem recriar os botões (não perde o foco de quem navega pelo teclado).
  function renderPresetState() {
    const { preset } = state.settings;
    for (const chip of el.chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.id === preset));
    el.save.hidden = preset !== null;
    el.remove.hidden = !customName(preset);
  }

  function syncBandInputs() {
    shown.forEach((g, i) => { bandInputs[i].value = g; });
  }

  // ---------- utilidades ----------

  function customName(preset) {
    return preset?.startsWith('custom:') ? preset.slice(7) : '';
  }

  function isRestricted(url) {
    if (!url) return false;
    return /^(chrome|edge|brave|opera|about|devtools|view-source|chrome-extension|chrome-search):/i.test(url)
      || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
  }

  function friendlyError(message = '') {
    if (/cannot be captured|chrome pages/i.test(message)) return 'Esta página não pode ser equalizada';
    if (/not been invoked|activeTab|permission/i.test(message)) return 'Feche e abra o equalizador de novo nesta aba';
    if (/active stream/i.test(message)) return 'Outra extensão já está usando o som desta aba';
    return message || 'Não deu para ligar o equalizador';
  }
})();
