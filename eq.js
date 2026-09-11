// Núcleo compartilhado entre popup, documento invisível e service worker:
// bandas, predefinições e construção dos filtros.
const EQ = (() => {
  // Oitavas exatas a partir de 1 kHz, então ficam igualmente espaçadas no eixo logarítmico.
  const BANDS = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const RANGE = 12; // dB para cima e para baixo
  const Q = 1.41;   // cerca de uma oitava de largura por banda

  // Ordem = quanto reforçam os graves (o uso principal), com o Plano na frente como volta ao neutro.
  // preamp negativo nas curvas que reforçam muito, para sobrar folga antes do limitador.
  const PRESETS = [
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

  // Aceita qualquer coisa vinda do storage e devolve ajustes válidos. Sem nada salvo, devolve o plano.
  function sanitize(s) {
    return {
      gains: BANDS.map((_, i) => step(s?.gains?.[i])),
      preamp: step(s?.preamp),
      preset: s == null ? 'flat' : typeof s.preset === 'string' ? s.preset : null,
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

  // Posição horizontal (0 a 1) no gráfico: cada banda ocupa uma coluna, centrada nela.
  const freqToX = (f) => (Math.log2(f / BANDS[0]) + 0.5) / BANDS.length;
  const xToFreq = (x) => BANDS[0] * Math.pow(2, x * BANDS.length - 0.5);

  function formatDb(v) {
    if (Math.abs(v) < 0.05) return '0';
    const n = Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 1).replace('.', ',');
    return (v > 0 ? '+' : '−') + n;
  }

  return { BANDS, LABELS, RANGE, PRESETS, clamp, sanitize, createFilters, dbToGain, freqToX, xToFreq, formatDb };
})();
