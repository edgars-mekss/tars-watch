// Голос в браузере: запись с микрофона → распознавание на сервере (Whisper), озвучка — Web Speech API.

export const canListen = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

const VOICE_RMS = 0.02; // громкость, которую считаем речью
const SILENCE_MS = 1200; // пауза после речи — конец фразы
const NO_SPEECH_MS = 6000; // так и не заговорили
const MAX_MS = 15000; // самая длинная фраза

const rms = (samples) => Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);

// Записывает одну фразу и возвращает распознанный текст ("" — тишина или отмена).
// onLevel(0..1) — громкость для анимации, onRecorded() — запись закончилась, идёт распознавание.
export function listen({ onLevel, onRecorded } = {}) {
  let request = null; // "stop" — закончить и распознать, "abort" — выбросить
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume(); // без этого анализатор может молча отдавать нули
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();

    const started = performance.now();
    let lastVoice = 0;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const level = rms(samples);
        onLevel?.(Math.min(1, level * 10));
        const now = performance.now();
        if (level > VOICE_RMS) lastVoice = now;
        const finished =
          request ||
          (lastVoice && now - lastVoice > SILENCE_MS) ||
          (!lastVoice && now - started > NO_SPEECH_MS) ||
          now - started > MAX_MS;
        if (finished) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });

    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    if (request === "abort" || !lastVoice) return "";

    onRecorded?.();
    // Chrome пишет audio/webm, Safari на iPhone — audio/mp4.
    const type = rec.mimeType || chunks[0]?.type || "audio/webm";
    const blob = new Blob(chunks, { type });
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": type },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data.text;
  })();
  return { done, stop: () => (request ??= "stop"), abort: () => (request = "abort") };
}

const SETTINGS_KEY = "tars.voice.v2"; // v2: голос по умолчанию — Silero «Евгений» без эффекта
// voiceURI: "" — голос сервера по умолчанию, "silero:<id>" или "piper:<id>" — голос сервера, иначе — голос браузера.
export const voiceSettings = { voiceURI: "", effect: "none", pitch: 0.7, rate: 1 };
try {
  Object.assign(voiceSettings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {});
} catch {}

export function saveVoiceSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(voiceSettings));
  } catch {}
}

export function russianVoices() {
  return "speechSynthesis" in window
    ? speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ru"))
    : [];
}

// Голоса и эффекты «голос робота», которые предлагает сервер: { voices: [{ id, name, engine }], effects: [...] }.
export async function serverVoices() {
  try {
    const res = await fetch("/api/voices");
    return await res.json();
  } catch {
    return { voices: [], effects: [] };
  }
}

// Мужские голоса ближе к ТАРСу из фильма.
const PREFERRED = ["Dmitry", "Pavel", "Yuri", "Maxim", "Google русский"];

function pickVoice() {
  const voices = russianVoices();
  return (
    voices.find((v) => v.voiceURI === voiceSettings.voiceURI) ??
    PREFERRED.map((name) => voices.find((v) => v.name.includes(name))).find(Boolean) ??
    voices[0]
  );
}

// Один общий <audio> для голоса с сервера. Обычный аудиоэлемент, а не Web Audio: на iPhone Web Audio
// молчит в беззвучном режиме. Safari пускает звук только после касания, поэтому при касании
// элемент «разблокируется» беззвучным файлом и дальше может играть ответы.
const player = new Audio();
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=";

// То же для голоса браузера: при первом касании произносим пустую фразу.
let unlocked = false;
export function unlockSpeech() {
  if (player.paused) {
    player.src = SILENT_WAV;
    player.play().catch(() => {});
  }
  if (unlocked || !("speechSynthesis" in window)) return;
  unlocked = true;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  speechSynthesis.speak(u);
}

let current = null; // держим ссылку, иначе Chrome может потерять onend
let finish = null; // завершает текущую фразу
let generation = 0; // растёт при каждой остановке: синтез, который не успел, не заговорит

// Произносит текст. onLevel(0..1) — громкость речи для анимации,
// onError(сообщение) — голос сервера не сработал и ТАРС перешёл на голос браузера.
export async function speak(text, onLevel, onError) {
  stopSpeaking();
  const voice = voiceSettings.voiceURI;
  if (!voice || /^(silero|piper):/.test(voice)) {
    try {
      return await speakServer(text, voice, onLevel);
    } catch (err) {
      onError?.(`Голос сервера: ${err.message}. Говорю голосом браузера.`);
    }
  }
  return speakBrowser(text, onLevel);
}

async function speakServer(text, voice, onLevel) {
  const gen = generation;
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, rate: voiceSettings.rate, effect: voiceSettings.effect }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const wav = await res.arrayBuffer();
  if (gen !== generation) return; // перебили, пока шёл синтез

  const levels = loudness(wav);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  return new Promise((resolve, reject) => {
    const meter = setInterval(() => onLevel?.(levels[Math.floor(player.currentTime / LEVEL_STEP_S)] ?? 0), 50);
    const cleanup = () => {
      finish = null;
      clearInterval(meter);
      player.onended = player.onerror = null;
      player.pause();
      URL.revokeObjectURL(url);
    };
    const done = () => {
      if (finish !== done) return;
      cleanup();
      resolve();
    };
    const fail = (message) => {
      if (finish !== done) return;
      cleanup();
      reject(new Error(message));
    };
    finish = done;
    player.onended = done;
    player.onerror = () => fail("браузер не смог воспроизвести звук");
    player.src = url;
    player.play().catch((err) => {
      fail(err.name === "NotAllowedError" ? "браузер не разрешил звук без касания" : err.message);
    });
  });
}

// Громкость WAV (PCM 16 бит) по кусочкам — для полосок под глазами во время речи.
const LEVEL_STEP_S = 0.05;
function loudness(buffer) {
  const view = new DataView(buffer);
  const rate = view.getUint32(24, true);
  let offset = 12;
  while (offset + 8 <= view.byteLength && view.getUint32(offset) !== 0x64617461 /* "data" */) {
    offset += 8 + view.getUint32(offset + 4, true);
  }
  const start = offset + 8;
  const end = Math.min(view.byteLength, start + view.getUint32(offset + 4, true));
  const step = Math.round(rate * LEVEL_STEP_S) * 2;
  const levels = [];
  for (let i = start; i + 1 < end; i += step) {
    let sum = 0;
    let n = 0;
    for (let j = i; j + 1 < Math.min(i + step, end); j += 2, n++) sum += (view.getInt16(j, true) / 32768) ** 2;
    levels.push(Math.min(1, Math.sqrt(sum / n) * 4));
  }
  return levels;
}

function speakBrowser(text, onLevel) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ru-RU";
    u.voice = pickVoice() ?? null;
    u.pitch = voiceSettings.pitch;
    u.rate = voiceSettings.rate;
    u.onboundary = () => onLevel?.(1);

    // Завершаем только «свою» фразу: onend отменённой фразы приходит асинхронно.
    const done = () => {
      if (finish !== done) return;
      clearTimeout(timer);
      finish = null;
      current = null;
      resolve();
    };
    // Подстраховка: в некоторых браузерах onend не приходит.
    const timer = setTimeout(done, 4000 + text.length * 110);
    finish = done;
    u.onend = u.onerror = done;
    current = u;
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  generation++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  finish?.();
}
