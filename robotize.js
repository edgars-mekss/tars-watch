// «Голос робота»: обработка синтезированной речи. На входе и выходе WAV, PCM 16 бит, моно.
// piper — дополнительные аргументы Piper (ровнее интонация). Дальше эффекты по порядку:
// pitch — понижение тона (Piper говорит быстрее во столько же раз, затем запись растягивается —
//         тон ниже, а скорость речи прежняя), band — «звук из динамика» (срез низких и высоких),
// drive — лёгкая насыщенность, comb — металлический призвук (короткое эхо с обратной связью),
// ring — кольцевая модуляция, crush — огрубление звука, как у старых синтезаторов речи.

const MONOTONE = ["--noise_scale", "0.3", "--noise_w", "0.05"];

export const EFFECTS = {
  film: {
    name: "Как в фильме",
    piper: ["--noise_scale", "0.5", "--noise_w", "0.4"],
    pitch: 0.84,
    band: { low: 220, high: 4200 },
    drive: 1.6,
    comb: { ms: 11, feedback: 0.15, mix: 0.2 },
  },
  metal: {
    name: "Металлический",
    piper: MONOTONE,
    comb: { ms: 7, feedback: 0.55, mix: 0.6 },
    ring: { hz: 40, depth: 0.2 },
  },
  droid: {
    name: "Дроид",
    piper: MONOTONE,
    comb: { ms: 3, feedback: 0.4, mix: 0.4 },
    ring: { hz: 55, depth: 0.9 },
  },
  computer: {
    name: "Старый компьютер",
    piper: MONOTONE,
    comb: { ms: 5, feedback: 0.3, mix: 0.3 },
    crush: { bits: 6, hold: 3 },
  },
  none: { name: "Без эффекта" },
};

export function robotize(wav, effectId) {
  const fx = EFFECTS[effectId];
  if (!fx || !(fx.pitch || fx.band || fx.drive || fx.comb || fx.ring || fx.crush)) return wav;

  const { rate, start, end } = findPcm(wav);
  let signal = new Float32Array((end - start) >> 1);
  for (let i = 0; i < signal.length; i++) signal[i] = wav.readInt16LE(start + i * 2) / 32768;

  if (fx.pitch) signal = stretch(signal, fx.pitch);
  if (fx.band) signal = band(signal, rate, fx.band);
  if (fx.drive) signal = drive(signal, fx.drive);
  if (fx.comb) signal = comb(signal, rate, fx.comb);
  if (fx.ring) signal = ring(signal, rate, fx.ring);
  if (fx.crush) signal = crush(signal, fx.crush);
  normalize(signal, 0.9);

  return toWav(signal, rate);
}

function findPcm(wav) {
  const rate = wav.readUInt32LE(24);
  let offset = 12;
  while (offset + 8 <= wav.length && wav.toString("ascii", offset, offset + 4) !== "data") {
    offset += 8 + wav.readUInt32LE(offset + 4);
  }
  const start = offset + 8;
  return { rate, start, end: Math.min(wav.length, start + wav.readUInt32LE(offset + 4)) };
}

function toWav(signal, rate) {
  const out = Buffer.alloc(44 + signal.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + signal.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); // размер блока fmt
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // моно
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(signal.length * 2, 40);
  for (let i = 0; i < signal.length; i++) out.writeInt16LE(Math.round(signal[i] * 32767), 44 + i * 2);
  return out;
}

// Растягивает запись в 1/factor раз: при той же частоте дискретизации тон ниже в factor раз.
function stretch(input, factor) {
  const out = new Float32Array(Math.floor(input.length / factor));
  for (let i = 0; i < out.length; i++) {
    const pos = i * factor;
    const j = Math.floor(pos);
    const t = pos - j;
    out[i] = input[j] * (1 - t) + (input[j + 1] ?? 0) * t;
  }
  return out;
}

// Полосовой фильтр из двух биквадов (RBJ): срез ниже low и выше high, как у маленького динамика.
function band(input, rate, { low, high }) {
  return biquad(biquad(input, rate, "highpass", low), rate, "lowpass", high);
}

function biquad(input, rate, type, freq, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * freq) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const [b0, b1, b2] = type === "lowpass" ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y;
    [x2, x1, y2, y1] = [x1, x, y1, y];
  }
  return out;
}

function drive(input, amount) {
  const out = new Float32Array(input.length);
  const norm = Math.tanh(amount);
  for (let i = 0; i < input.length; i++) out[i] = Math.tanh(input[i] * amount) / norm;
  return out;
}

function comb(input, rate, { ms, feedback, mix }) {
  const delay = Math.max(1, Math.round((rate * ms) / 1000));
  const wet = new Float32Array(input.length);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    wet[i] = input[i] + (i >= delay ? feedback * wet[i - delay] : 0);
    out[i] = (1 - mix) * input[i] + mix * wet[i];
  }
  return out;
}

function ring(input, rate, { hz, depth }) {
  const out = new Float32Array(input.length);
  const w = (2 * Math.PI * hz) / rate;
  for (let i = 0; i < input.length; i++) out[i] = input[i] * (1 - depth + depth * Math.sin(w * i));
  return out;
}

function crush(input, { bits, hold }) {
  const steps = 2 ** (bits - 1);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const held = input[i - (i % hold)];
    out[i] = Math.round(held * steps) / steps;
  }
  return out;
}

function normalize(signal, target) {
  let peak = 0;
  for (const v of signal) peak = Math.max(peak, Math.abs(v));
  if (!peak) return;
  const gain = target / peak;
  for (let i = 0; i < signal.length; i++) signal[i] *= gain;
}
