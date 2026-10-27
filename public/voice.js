// Голос в браузере: запись с микрофона → распознавание на сервере (Whisper), озвучка — Web Speech API.

export const canListen = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

const VOICE_RMS = 0.02; // громкость, которую считаем речью
const SILENCE_MS = 1200; // пауза после речи — конец фразы
const NO_SPEECH_MS = 6000; // так и не заговорили
const MAX_MS = 15000; // самая длинная фраза

// Записывает одну фразу и возвращает распознанный текст ("" — тишина или отмена).
// onLevel(0..1) — громкость для анимации, onRecorded() — запись закончилась, идёт распознавание.
export function listen({ onLevel, onRecorded } = {}) {
  let request = null; // "stop" — закончить и распознать, "abort" — выбросить
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext();
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
        const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
        onLevel?.(Math.min(1, rms * 10));
        const now = performance.now();
        if (rms > VOICE_RMS) lastVoice = now;
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
    const blob = new Blob(chunks, { type: rec.mimeType });
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data.text;
  })();
  return { done, stop: () => (request ??= "stop"), abort: () => (request = "abort") };
}

const SETTINGS_KEY = "tars.voice";
export const voiceSettings = { voiceURI: "", pitch: 0.7, rate: 1.05 };
try {
  Object.assign(voiceSettings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {});
} catch {}

export function saveVoiceSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(voiceSettings));
  } catch {}
}

export function russianVoices() {
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ru"));
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

let current = null; // держим ссылку, иначе Chrome может потерять onend
let finish = null;

export function speak(text, onBoundary) {
  stopSpeaking();
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ru-RU";
    u.voice = pickVoice() ?? null;
    u.pitch = voiceSettings.pitch;
    u.rate = voiceSettings.rate;
    u.onboundary = () => onBoundary?.();

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
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  finish?.();
}
