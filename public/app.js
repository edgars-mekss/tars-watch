// Логика прототипа: состояния робота, касания экрана, разговор с сервером.
import { Face, COLORS } from "./face.js";
import * as voice from "./voice.js";

const $ = (id) => document.getElementById(id);

const face = new Face($("face"));
const screen = $("screen");
const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

const SETTING_NAMES = { humor: "Юмор", sarcasm: "Сарказм", honesty: "Честность" };
let settings = { humor: 0, sarcasm: 0, honesty: 90 };

let state = "off";
let listener = null;
let relaxTimer = 0;
let greeted = false;

// ---- Состояния ----

function setState(next) {
  state = next;
  face.setState(next);
  $("hint").textContent = next === "off" ? "Коснитесь, чтобы включить" : "Коснитесь, чтобы говорить";
  $("hint").classList.toggle("hidden", !(next === "off" || (next === "idle" && !greeted)));
  // После ответа выражение через несколько секунд возвращается к спокойному.
  clearTimeout(relaxTimer);
  if (next === "idle") relaxTimer = setTimeout(() => face.setEmotion("neutral"), 5000);
}

function subtitle(text, who = "robot") {
  const el = $("subtitle");
  el.textContent = text;
  el.className = `subtitle ${who}` + (text ? "" : " hidden");
}

function log(text, isError = false) {
  $("log").textContent = text;
  $("log").classList.toggle("error", isError);
}

// ---- Касания ----

async function onTap() {
  voice.unlockSpeech();
  switch (state) {
    case "off":
      return ask({ boot: true });
    case "idle":
      return startListening();
    case "listening":
      return listener?.stop();
    case "speaking":
      return voice.stopSpeaking();
  }
}

async function startListening() {
  if (!voice.canListen) {
    log("Браузер не даёт доступ к микрофону. Пишите в поле выше.", true);
    $("text-input").focus();
    return;
  }
  greeted = true;
  setState("listening");
  subtitle("");
  log("");
  const current = voice.listen({
    onLevel: (level) => face.setLevel(level),
    onRecorded: () => setState("thinking"),
  });
  listener = current;
  let text = "";
  try {
    text = await current.done;
  } catch (err) {
    log(`Микрофон: ${micError(err)}`, true);
  }
  if (listener !== current) return; // разговор сбросили или перебили текстом
  listener = null;
  if (!text) {
    setState("idle");
    face.setEmotion("confused");
    subtitle("");
    return;
  }
  ask({ text });
}

function micError(err) {
  if (err.name === "NotAllowedError") return "доступ запрещён — разрешите микрофон в адресной строке браузера";
  if (err.name === "NotFoundError") return "микрофон не найден";
  return err.message;
}

// ---- Разговор с сервером ----

async function ask(payload) {
  greeted ||= !payload.boot;
  setState("thinking");
  face.setEmotion("neutral");
  subtitle(payload.text ?? "", "user");
  log("");

  let result;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, lang: voice.voiceSettings.lang, ...payload }),
    });
    result = await res.json();
    if (!res.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
  } catch (err) {
    log(err.message, true);
    const reply = voice.voiceSettings.lang === "en" ? "Connection to the server is lost." : "Связь с сервером потеряна.";
    result = { reply, emotion: "error", settings: null };
  }
  if (state !== "thinking") return; // за время ожидания часы выключили

  if (result.settings) showSettingsChange(result.settings);
  face.setEmotion(result.emotion);
  setState("speaking");
  subtitle(result.reply);
  await voice.speak(result.reply, (level) => face.setLevel(level), (msg) => log(msg, true));
  if (state === "speaking") setState("idle");
}

// ---- Настройки личности ----

let overlayTimer = 0;

function showSettingsChange(next) {
  const changed = Object.keys(SETTING_NAMES).find((k) => next[k] !== settings[k]);
  settings = next;
  renderSettings();
  if (!changed) return;
  $("ov-label").textContent = SETTING_NAMES[changed].toUpperCase();
  $("ov-value").textContent = `${next[changed]}%`;
  $("ov-fill").style.width = `${next[changed]}%`;
  $("overlay").classList.add("show");
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => $("overlay").classList.remove("show"), 2200);
}

function renderSettings() {
  $("settings").replaceChildren(
    ...Object.entries(SETTING_NAMES).flatMap(([key, name]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = name;
      dd.textContent = `${settings[key]}%`;
      return [dt, dd];
    }),
  );
}

// ---- Пульт отладки ----

function setupPanel() {
  screen.addEventListener("click", onTap);
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.target.closest("input, select, button, textarea")) {
      e.preventDefault();
      onTap();
    }
  });

  $("text-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("text-input").value.trim();
    if (!text || state === "thinking") return;
    $("text-input").value = "";
    listener?.abort();
    listener = null;
    voice.stopSpeaking();
    ask({ text });
  });

  $("reset").addEventListener("click", () => {
    listener?.abort();
    listener = null;
    voice.stopSpeaking();
    setState("off");
    face.setEmotion("neutral");
    subtitle("");
    greeted = false;
    settings = { humor: 0, sarcasm: 0, honesty: 90 };
    renderSettings();
    fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    log("Разговор сброшен.");
  });

  $("subs").addEventListener("change", (e) => screen.classList.toggle("subs-off", !e.target.checked));

  for (const s of ["off", "idle", "listening", "thinking", "speaking"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.onclick = () => {
      face.setState(s);
      if (s === "speaking") demoSpeech();
    };
    $("states").append(b);
  }
  for (const e of Object.keys(COLORS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.onclick = () => face.setEmotion(e);
    $("emotions").append(b);
  }

  // Голос
  const { pitch, rate } = voice.voiceSettings;
  $("pitch").value = pitch;
  $("rate").value = rate;
  const syncVoice = () => {
    voice.voiceSettings.pitch = Number($("pitch").value);
    voice.voiceSettings.rate = Number($("rate").value);
    voice.langVoice().voiceURI = $("voice-select").value;
    if ($("effect-select").value) voice.langVoice().effect = $("effect-select").value;
    $("pitch-out").textContent = voice.voiceSettings.pitch.toFixed(2);
    $("rate-out").textContent = voice.voiceSettings.rate.toFixed(2);
    voice.saveVoiceSettings();
  };
  for (const id of ["pitch", "rate", "voice-select", "effect-select"]) $(id).addEventListener("input", syncVoice);
  const TEST_PHRASE = {
    ru: "Голосовой модуль проверен. Все системы в норме, Купер.",
    en: "Voice module check complete. All systems nominal, Cooper.",
  };
  const testVoice = () => {
    voice.unlockSpeech();
    voice.speak(TEST_PHRASE[voice.voiceSettings.lang], (level) => face.setLevel(level), (msg) => log(msg, true));
  };
  $("voice-select").addEventListener("change", testVoice);
  $("effect-select").addEventListener("change", testVoice);

  // Голоса текущего языка: сначала с сервера (Silero, Piper), потом голоса браузера.
  let serverList = [];
  let effects = [];
  const fillVoices = () => {
    const { voiceURI, effect } = voice.langVoice();
    const own = serverList.filter((v) => v.lang === voice.voiceSettings.lang);
    const option = (label, value, selected) => new Option(label, value, false, value === selected);
    $("voice-select").replaceChildren(
      option(own.length ? `Авто (${own[0].name})` : "Авто", "", voiceURI),
      ...own.map((v) => option(`${v.name} — ${v.engine}`, v.id, voiceURI)),
      ...voice.browserVoices().map((v) => option(`${v.name} — браузер`, v.voiceURI, voiceURI)),
    );
    $("effect-select").replaceChildren(...effects.map((fx) => option(fx.name, fx.id, effect)));
  };
  fillVoices();
  voice.serverVoices().then((data) => {
    serverList = data.voices ?? [];
    effects = data.effects ?? [];
    fillVoices();
    if (!serverList.length) log("На сервере нет Silero и Piper — озвучка голосом браузера, эффекты недоступны.");
  });

  // Язык разговора: ТАРС слушает и отвечает на нём, у каждого языка свой голос.
  $("lang-select").value = voice.voiceSettings.lang;
  $("lang-select").addEventListener("change", () => {
    voice.voiceSettings.lang = $("lang-select").value;
    voice.saveVoiceSettings();
    fillVoices();
    testVoice();
  });
  if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", fillVoices);
  $("pitch-out").textContent = Number(pitch).toFixed(2);
  $("rate-out").textContent = Number(rate).toFixed(2);

  renderSettings();
}

// Импульсы «речи» для просмотра анимации без озвучки.
function demoSpeech() {
  const tick = () => {
    if (face.state !== "speaking") return;
    face.pulse();
    setTimeout(tick, 180 + Math.random() * 220);
  };
  tick();
}

// ---- Часы и масштаб ----

function updateClock() {
  $("clock").textContent = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

const WATCH_W = 470; // корпус с заводной головкой, px при масштабе 1
const WATCH_H = 760; // вместе с ремешками

function fitWatch() {
  const narrow = innerWidth <= 760;
  const availW = innerWidth - 32 - (narrow ? 0 : 340 + 32);
  const availH = innerHeight - 32;
  const scale = Math.min(1, availW / WATCH_W, availH / WATCH_H);
  document.documentElement.style.setProperty("--scale", scale.toFixed(3));
}

setupPanel();
setState("off");
updateClock();
setInterval(updateClock, 10_000);
fitWatch();
addEventListener("resize", fitWatch);
