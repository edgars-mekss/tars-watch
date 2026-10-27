// «Голос робота»: обработка синтезированной речи. На входе и выходе WAV, PCM 16 бит, моно.
// monotone — Piper говорит ровнее (меньше «живой» интонации), остальное — эффекты по порядку:
// comb — металлический призвук (короткое эхо с обратной связью), ring — кольцевая модуляция,
// crush — огрубление звука, как у старых синтезаторов речи.

export const EFFECTS = {
  metal: {
    name: "Металлический",
    monotone: true,
    comb: { ms: 7, feedback: 0.55, mix: 0.6 },
    ring: { hz: 40, depth: 0.2 },
  },
  droid: {
    name: "Дроид",
    monotone: true,
    comb: { ms: 3, feedback: 0.4, mix: 0.4 },
    ring: { hz: 55, depth: 0.9 },
  },
  computer: {
    name: "Старый компьютер",
    monotone: true,
    comb: { ms: 5, feedback: 0.3, mix: 0.3 },
    crush: { bits: 6, hold: 3 },
  },
  none: { name: "Без эффекта" },
};

// Аргументы Piper для ровной интонации.
export const MONOTONE_ARGS = ["--noise_scale", "0.3", "--noise_w", "0.05"];

export function robotize(wav, effectId) {
  const fx = EFFECTS[effectId];
  if (!fx || !(fx.comb || fx.ring || fx.crush)) return wav;

  const { rate, start, end } = findPcm(wav);
  let signal = new Float32Array((end - start) >> 1);
  for (let i = 0; i < signal.length; i++) signal[i] = wav.readInt16LE(start + i * 2) / 32768;

  if (fx.comb) signal = comb(signal, rate, fx.comb);
  if (fx.ring) signal = ring(signal, rate, fx.ring);
  if (fx.crush) signal = crush(signal, fx.crush);
  normalize(signal, 0.9);

  const out = Buffer.from(wav);
  for (let i = 0; i < signal.length; i++) out.writeInt16LE(Math.round(signal[i] * 32767), start + i * 2);
  return out;
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
