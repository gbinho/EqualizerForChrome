// Deslocador de tom: duas leituras da mesma linha de atraso, com crossfade entre elas.
// Muda o tom sem mexer na velocidade, e roda dentro do processador de áudio do Chrome.
const SIZE = 4096; // ~85 ms a 48 kHz
const HALF = SIZE / 2;
const UNITY = 0.0005; // perto o bastante de 1 para tratar como "sem mudança"

function sample(buffer, position) {
  const index = Math.floor(position);
  const frac = position - index;
  const a = buffer[index];
  const b = buffer[index + 1 === SIZE ? 0 : index + 1];
  return a + (b - a) * frac;
}

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.buffers = [];
    this.write = 0;
    this.read = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0]) return true;

    const channels = output.length;
    const frames = output[0].length;
    const ratio = parameters.ratio[0];
    const bypass = Math.abs(ratio - 1) < UNITY;

    while (this.buffers.length < channels) this.buffers.push(new Float32Array(SIZE));

    let write = this.write;
    let read = this.read;

    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const source = input[ch] || input[0];
        this.buffers[ch][write] = source[i];
      }

      if (bypass) {
        for (let ch = 0; ch < channels; ch++) {
          const source = input[ch] || input[0];
          output[ch][i] = source[i];
        }
      } else {
        // As duas leituras ficam a meio buffer de distância; a janela cruza uma na outra,
        // e os dois ganhos sempre somam 1, então o volume não oscila.
        const phase = ((write - read + SIZE) % SIZE) / SIZE;
        const gainA = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
        const gainB = 1 - gainA;
        const posB = read + HALF >= SIZE ? read + HALF - SIZE : read + HALF;
        for (let ch = 0; ch < channels; ch++) {
          const buffer = this.buffers[ch];
          output[ch][i] = gainA * sample(buffer, read) + gainB * sample(buffer, posB);
        }
        read += ratio;
        if (read >= SIZE) read -= SIZE;
      }

      write = write + 1 === SIZE ? 0 : write + 1;
    }

    // Sem mudança de tom, a leitura acompanha a escrita para não saltar quando o tom voltar a mexer.
    this.write = write;
    this.read = bypass ? write : read;
    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
