// Núcleo compartilhado entre popup, documento invisível e service worker:
// bandas, predefinições, efeitos e construção dos filtros.
const EQ = (() => {
  // Série ISO de 2/3 de oitava, o padrão dos equalizadores de 16 bandas.
  // Fica espaçada por igual no eixo logarítmico e cobre de 20 Hz a 20 kHz.
  const BANDS = [20, 31.5, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 12500, 20000];
  const LABELS = ['20', '31', '50', '80', '125', '200', '315', '500', '800', '1,2k', '2k', '3,1k', '5k', '8k', '12k', '20k'];
  const RANGE = 18;       // dB para cima e para baixo
  const Q = 2.1;          // 2/3 de oitava de largura por banda
  const PITCH_RANGE = 12; // semitons para cima e para baixo
  const SPEED = { min: 0.5, max: 2, step: 0.05, normal: 1 };

  // Isolar usa a posicao no estereo: voz quase sempre no centro, instrumentos espalhados.
  const SEPARATE = [
    { id: 'off', name: 'Normal' },
    { id: 'beat', name: 'Sem voz' },
    { id: 'vocal', name: 'Só voz' },
  ];

  // As bandas em oitavas que a extensão usava até a versão 1.2. As curvas abaixo e os
  // ajustes já salvos por quem usa continuam escritos nelas, e são convertidos na hora.
  const LEGACY_BANDS = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  // Ordem = quanto reforçam os graves (o uso principal), com o Plano na frente como volta ao neutro.
  // preamp negativo nas curvas que reforçam muito, para sobrar folga antes do limitador.
  const CURVES = [
    { id: 'flat', name: 'Plano', preamp: 0, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bass', name: 'Mais graves', preamp: -4, gains: [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0] },
    { id: 'electronic', name: 'Eletrônica', preamp: -3, gains: [6, 5, 1.5, 0, -2, 0, 1, 2, 4, 5] },
    { id: 'hiphop', name: 'Hip-hop', preamp: -3, gains: [6, 5, 2, 3, -1, -1, 1, 0, 2, 3] },
    { id: 'rock', name: 'Rock', preamp: -3, gains: [5, 4, 2, -1, -2, -1, 1, 3, 4, 5] },
    { id: 'lowvol', name: 'Volume baixo', preamp: -3, gains: [6, 4.5, 2, 0, -1, 0, 0, 1.5, 3.5, 5] },
    { id: 'acoustic', name: 'Acústico', preamp: -2.5, gains: [4, 4, 3, 1, 2, 2, 3, 3, 3, 2] },
    { id: 'classical', name: 'Clássica', preamp: -2, gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
    { id: 'jazz', name: 'Jazz', preamp: -1.5, gains: [3, 2, 1, 2, -1.5, -1.5, 0, 1, 2, 3] },
    { id: 'pop', name: 'Pop', preamp: -2, gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
    { id: 'vocal', name: 'Voz', preamp: -2, gains: [-3, -2.5, -1, 1, 3, 4, 3.5, 2, 0, -1] },
    { id: 'treble', name: 'Mais agudos', preamp: -3, gains: [0, 0, 0, 0, 0, 1, 2.5, 4, 5.5, 6.5] },
  ];

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const step = (v) => Math.round(clamp(Number(v) || 0, -RANGE, RANGE) * 2) / 2;
  const whole = (v, min, max) => Math.round(clamp(Number(v) || 0, min, max));

  // Lê uma curva escrita em outras frequências, interpolando no eixo logarítmico.
  // Fora das pontas, repete o valor da ponta.
  function readCurve(freqs, gains, target) {
    const x = Math.log2(target);
    if (x <= Math.log2(freqs[0])) return gains[0];
    const last = freqs.length - 1;
    if (x >= Math.log2(freqs[last])) return gains[last];
    for (let i = 1; i <= last; i++) {
      const hi = Math.log2(freqs[i]);
      if (x > hi) continue;
      const lo = Math.log2(freqs[i - 1]);
      return gains[i - 1] + (gains[i] - gains[i - 1]) * ((x - lo) / (hi - lo));
    }
    return gains[last];
  }

  // Converte uma curva das bandas antigas para as de hoje, mantendo o desenho.
  const fromLegacy = (gains) => BANDS.map((freq) => step(readCurve(LEGACY_BANDS, gains, freq)));

  const PRESETS = CURVES.map((p) => ({ ...p, gains: fromLegacy(p.gains) }));

  // Aceita qualquer coisa vinda do storage e devolve ajustes válidos. Sem nada salvo, devolve o plano.
  // Ajustes salvos nas bandas antigas são convertidos em vez de descartados.
  function sanitize(s) {
    const saved = Array.isArray(s?.gains) ? s.gains : [];
    const gains = saved.length === LEGACY_BANDS.length && BANDS.length !== LEGACY_BANDS.length
      ? fromLegacy(saved)
      : BANDS.map((_, i) => step(saved[i]));
    return {
      gains,
      preamp: step(s?.preamp),
      preset: s == null ? 'flat' : typeof s.preset === 'string' ? s.preset : null,
      pitch: whole(s?.pitch, -PITCH_RANGE, PITCH_RANGE),
      ambience: whole(s?.ambience, 0, 100),
      level: whole(s?.level, 0, 100),
      separate: SEPARATE.some((m) => m.id === s?.separate) ? s.separate : 'off',
      keepPitch: s?.keepPitch !== false,
    };
  }

  function createFilters(ctx) {
    return BANDS.map((freq) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = Q;
      f.gain.value = 0;
      return f;
    });
  }

  const dbToGain = (db) => Math.pow(10, db / 20);
  const semitonesToRatio = (semitones) => Math.pow(2, semitones / 12);
  const speedOf = (v) => clamp(Number(v) || SPEED.normal, SPEED.min, SPEED.max);

  // Posição horizontal (0 a 1) no gráfico: cada banda ocupa uma coluna, centrada nela.
  const OCTAVES = Math.log2(BANDS[BANDS.length - 1] / BANDS[0]) / (BANDS.length - 1);
  const freqToX = (f) => (Math.log2(f / BANDS[0]) / OCTAVES + 0.5) / BANDS.length;
  const xToFreq = (x) => BANDS[0] * Math.pow(2, (x * BANDS.length - 0.5) * OCTAVES);

  function formatDb(v) {
    if (Math.abs(v) < 0.05) return '0';
    const n = Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 1).replace('.', ',');
    return (v > 0 ? '+' : '−') + n;
  }

  // Sem esticar o som, o tom acompanha a velocidade: isto diz quanto ele anda.
  const speedSemitones = (rate) => 12 * Math.log2(rate);
  const formatSpeed = (v) => `${v.toFixed(2).replace('.', ',')}×`;

  return {
    BANDS, LABELS, RANGE, PITCH_RANGE, SPEED, SEPARATE, PRESETS,
    clamp, sanitize, createFilters, dbToGain, semitonesToRatio, speedOf,
    freqToX, xToFreq, formatDb, formatSpeed, speedSemitones,
  };
})();
