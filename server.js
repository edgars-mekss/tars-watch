// Локальный сервер: отдаёт веб-прототип из public/ и проксирует разговор в языковую модель,
// чтобы ключ не попадал в браузер. Провайдер выбирается в .env (LLM_PROVIDER).
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { BOOT_MESSAGE, EMOTIONS, REPLY_SCHEMA, SYSTEM_PROMPT } from "./persona.js";
import { EFFECTS, robotize } from "./robotize.js";

try {
  process.loadEnvFile(); // ключи и выбор модели из .env
} catch {
  // .env нет — берём переменные окружения
}

const PORT = Number(process.env.PORT) || 3000;
// На VPS сервер слушает только 127.0.0.1, а наружу его выставляет Caddy с настоящим HTTPS.
const LISTEN_HOST = process.env.LISTEN_HOST ?? "0.0.0.0";
// Секретная ссылка: если ACCESS_TOKEN задан, пускаем только с ним — иначе чужие потратят лимит Groq.
// Первый вход — https://адрес/?key=TOKEN, дальше браузер помнит cookie. Приложение для часов шлёт
// заголовок Authorization: Bearer TOKEN.
const ACCESS_TOKEN = process.env.ACCESS_TOKEN ?? "";
const COOKIE = "tars_key";
// HTTPS нужен телефону: без него браузер не даёт микрофон. Сертификат — `npm run cert`.
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CERT_FILE = path.join(ROOT, "certs", "cert.pem");
const KEY_FILE = path.join(ROOT, "certs", "key.pem");
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_BODY = 16 * 1024;
const MAX_AUDIO = 5 * 1024 * 1024; // ~15 секунд речи с запасом

// "openai" — любой OpenAI-совместимый API (по умолчанию бесплатный Groq), "anthropic" — Claude.
const PROVIDER = process.env.LLM_PROVIDER ?? "openai";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
const MODEL = process.env.LLM_MODEL ?? (PROVIDER === "anthropic" ? "claude-opus-5-5" : "openai/gpt-oss-120b");
// Глубина рассуждений для моделей, которые её поддерживают (gpt-oss: low | medium | high).
const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT;
// Бесплатные тарифы считают токены, поэтому модели уходит только хвост разговора,
// а длина ответа (вместе с рассуждениями) ограничена.
const HISTORY_LIMIT = 16;
const MAX_REPLY_TOKENS = 800;
// Упёрлись в поминутный лимит — ждём, если сервис просит подождать не дольше этого.
const MAX_RATE_WAIT_S = 8;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// История разговоров в памяти: sessionId → сообщения в формате провайдера.
const sessions = new Map();

function shipTime() {
  return new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

const clamp = (n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0)));

class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// OpenAI-совместимый API: Groq, OpenRouter, Mistral, Cerebras, локальная Ollama и т. п.
async function askOpenAI(messages, retry = true) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY ?? ""}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages.slice(-HISTORY_LIMIT)],
      max_tokens: MAX_REPLY_TOKENS,
      ...(REASONING_EFFORT && { reasoning_effort: REASONING_EFFORT }),
      response_format: {
        type: "json_schema",
        json_schema: { name: "tars_reply", strict: true, schema: REPLY_SCHEMA },
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  // Открытые модели иногда не укладываются в схему — одна повторная попытка обычно помогает.
  const badJson = data.error?.code === "json_validate_failed" || "failed_generation" in (data.error ?? {});
  if (res.status === 400 && badJson && retry) return askOpenAI(messages, false);
  const wait = Number(res.headers.get("retry-after"));
  if (res.status === 429 && retry && wait > 0 && wait <= MAX_RATE_WAIT_S) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    return askOpenAI(messages, false);
  }
  if (!res.ok) throw new ProviderError(res.status, data.error?.message ?? res.statusText);
  const { prompt_tokens, completion_tokens } = data.usage ?? {};
  console.log(`${MODEL}: ${prompt_tokens} + ${completion_tokens} токенов`);
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  return { raw, assistant: { role: "assistant", content: raw } };
}

let anthropic; // создаём лениво, чтобы лицо можно было отлаживать и без ключа

// Claude: историю передаём целиком и только дописываем — блоки ответа (включая thinking)
// уходят обратно без изменений.
async function askAnthropic(messages) {
  anthropic ??= new Anthropic();
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: REPLY_SCHEMA },
    },
    messages,
  });
  if (response.stop_reason === "refusal") return null;
  const raw = response.content.find((b) => b.type === "text")?.text ?? "{}";
  return { raw, assistant: { role: "assistant", content: response.content } };
}

async function chat(sessionId, { text, boot }) {
  if (boot) sessions.delete(sessionId);
  let messages = sessions.get(sessionId);
  if (!messages) sessions.set(sessionId, (messages = []));

  const said = boot ? BOOT_MESSAGE : text.trim();
  messages.push({ role: "user", content: `${said}
[Бортовое время: ${shipTime()}]` });

  let answer;
  try {
    answer = await (PROVIDER === "anthropic" ? askAnthropic : askOpenAI)(messages);
  } catch (err) {
    messages.pop(); // запрос не прошёл — реплику Купера убираем, чтобы история не сломалась
    throw err;
  }
  if (!answer) {
    messages.pop();
    return { reply: "Запрос отклонён протоколом безопасности.", emotion: "confused", settings: null };
  }

  messages.push(answer.assistant);
  const out = JSON.parse(answer.raw);
  return {
    reply: out.reply,
    emotion: EMOTIONS.includes(out.emotion) ? out.emotion : "neutral",
    settings: { humor: clamp(out.humor), sarcasm: clamp(out.sarcasm), honesty: clamp(out.honesty) },
  };
}

// Распознавание речи: Whisper через OpenAI-совместимый API (по умолчанию тот же Groq и тот же ключ).
const STT_BASE_URL = process.env.STT_BASE_URL ?? BASE_URL;
const STT_MODEL = process.env.STT_MODEL ?? "whisper-large-v3-turbo";
// Whisper на тишине и шуме «слышит» титры из видео, на которых его обучали.
const HALLUCINATIONS = ["субтитры", "продолжение следует", "спасибо за просмотр", "dimatorzok", "редактор субтитров"];

async function transcribe(audio, type = "audio/webm") {
  const ext = type.split(/[/;]/)[1]?.replace("x-", "") || "webm"; // audio/webm;codecs=opus → webm
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `speech.${ext}`);
  form.append("model", STT_MODEL);
  form.append("language", "ru");
  form.append("temperature", "0");
  form.append("response_format", "json");
  const res = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STT_API_KEY ?? process.env.LLM_API_KEY ?? ""}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status, data.error?.message ?? res.statusText);
  const text = (data.text ?? "").trim();
  console.log(`${STT_MODEL}: «${text}»`);
  return HALLUCINATIONS.some((h) => text.toLowerCase().includes(h)) ? "" : text;
}

// Озвучка: два локальных бесплатных движка. По умолчанию берём их из «Помощника» (D:\Project3).
// Silero звучит живее (основной голос ТАРСа — Евгений), Piper — запасной.
const MAX_TTS_CHARS = 600;
const tempWav = () => path.join(os.tmpdir(), `tars-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

const PIPER_EXE = process.env.PIPER_EXE ?? "D:/Project3/runtime/piper/piper.exe";
const PIPER_VOICES_DIR = process.env.PIPER_VOICES ?? "D:/Project3/runtime/voices";
const PIPER_NAMES = { dmitri: "Дмитрий", denis: "Денис", ruslan: "Руслан" };
const piperModel = (voice) => path.join(PIPER_VOICES_DIR, `ru_RU-${voice}-medium.onnx`);

async function piperSynth(text, voice, rate, fx) {
  const out = tempWav();
  // Для эффекта с понижением тона Piper говорит быстрее: после растяжки скорость речи вернётся.
  const lengthScale = ((fx.pitch ?? 1) / rate).toFixed(3);
  await new Promise((resolve, reject) => {
    const args = ["--model", piperModel(voice), "--output_file", out, "--length_scale", lengthScale, "--quiet"];
    args.push(...(fx.piper ?? []));
    const piper = spawn(PIPER_EXE, args, { cwd: path.dirname(PIPER_EXE), windowsHide: true });
    piper.on("error", reject);
    piper.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Piper завершился с кодом ${code}`))));
    piper.stdin.end(text, "utf8");
  });
  try {
    return await readFile(out);
  } finally {
    await rm(out, { force: true });
  }
}

const SILERO_PY = process.env.SILERO_PY ?? "D:/Project3/runtime/pyenv/Scripts/python.exe";
const SILERO_MODEL = process.env.SILERO_MODEL ?? "D:/Project3/runtime/silero/v5_6_ru.pt";
const SILERO_NAMES = { eugene: "Евгений", aidar: "Айдар" };

// Silero — отдельный процесс Python (tts/silero_worker.py): модель грузится один раз,
// дальше по строке JSON на фразу. Фразы идут по очереди.
class Silero {
  #proc = null;
  #ready = null;
  #waiting = [];
  #queue = Promise.resolve();

  available() {
    return existsSync(SILERO_PY) && existsSync(SILERO_MODEL);
  }

  #nextLine() {
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  start() {
    if (this.#ready) return this.#ready;
    const proc = spawn(SILERO_PY, ["-I", path.join(ROOT, "tts", "silero_worker.py"), SILERO_MODEL], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.#waiting.shift()?.(line));
    const stop = (why) => {
      this.#ready = null;
      for (const resolve of this.#waiting.splice(0)) resolve(JSON.stringify({ error: why }));
    };
    proc.on("error", (err) => stop(`Silero не запустился: ${err.message}`));
    proc.on("exit", () => stop("Silero остановился"));
    this.#proc = proc;
    this.#ready = this.#nextLine().then((line) => {
      if (!line.includes('"ready"')) {
        this.#ready = null;
        throw new Error(JSON.parse(line).error ?? "Silero не запустился");
      }
    });
    return this.#ready;
  }

  synth(text, speaker, speed) {
    const job = this.#queue.then(async () => {
      await this.start();
      const out = tempWav();
      try {
        const answer = this.#nextLine();
        this.#proc.stdin.write(JSON.stringify({ text, speaker, speed, out, rate: 24000 }) + "\n");
        const result = JSON.parse(await answer);
        if (!result.ok) throw new Error(result.error ?? "Silero: ошибка синтеза");
        return await readFile(out);
      } finally {
        await rm(out, { force: true });
      }
    });
    this.#queue = job.catch(() => {});
    return job;
  }
}

const silero = new Silero();

// Доступные голоса: [{ id: "silero:eugene", name, engine }], первый — голос по умолчанию.
function voices() {
  const list = [];
  if (silero.available()) {
    for (const [id, name] of Object.entries(SILERO_NAMES)) list.push({ id: `silero:${id}`, name, engine: "Silero" });
  }
  if (existsSync(PIPER_EXE)) {
    for (const [id, name] of Object.entries(PIPER_NAMES)) {
      if (existsSync(piperModel(id))) list.push({ id: `piper:${id}`, name, engine: "Piper" });
    }
  }
  return list;
}

async function synthesize(text, voiceId, rate = 1, effect = "none") {
  const fx = EFFECTS[effect] ?? {};
  const speed = Math.min(2, Math.max(0.5, Number(rate) || 1));
  const [engine, voice] = voiceId.split(":");
  // Понижать тон без замедления речи умеем только с Piper (он говорит быстрее), поэтому Silero — без него.
  if (engine === "silero") return robotize(await silero.synth(text, voice, speed), effect, { pitch: false });
  return robotize(await piperSynth(text, voice, speed, fx), effect);
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Ключ API не найден или неверный";
  if (err instanceof Anthropic.RateLimitError) return "Превышен лимит запросов к API";
  if (err instanceof Anthropic.APIError) return `Ошибка API ${err.status ?? ""}: ${err.message}`;
  if (err instanceof ProviderError) {
    if (err.status === 401) return "Ключ API не найден или неверный (LLM_API_KEY в .env)";
    if (err.status === 429) return "Исчерпан лимит бесплатного тарифа — подождите или смените модель";
    return `Ошибка API ${err.status}: ${err.message}`;
  }
  return err.message;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Слишком большой запрос"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = (await readBody(req, MAX_BODY)).toString("utf8");
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Некорректный JSON");
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: "Не найдено" });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Не найдено" });
  }
}

function sameSecret(given) {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(ACCESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// true — запрос пропущен; иначе ответ уже отправлен (переадресация или отказ).
function checkAccess(req, res) {
  if (!ACCESS_TOKEN) return true;
  const url = new URL(req.url, "http://localhost");
  const key = url.searchParams.get("key");
  if (key !== null) {
    if (!sameSecret(key)) return deny(res);
    url.searchParams.delete("key");
    res.writeHead(303, {
      "Set-Cookie": `${COOKIE}=${encodeURIComponent(key)}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`,
      Location: url.pathname + url.search,
    });
    res.end();
    return false;
  }
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const cookie = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === COOKIE)?.[1];
  if (sameSecret(bearer) || sameSecret(cookie && safeDecode(cookie))) return true;
  return deny(res);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function deny(res) {
  res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("TARS: нужна ссылка доступа.");
  return false;
}

async function handle(req, res) {
  if (!checkAccess(req, res)) return;
  try {
    if (req.method === "POST" && req.url === "/api/chat") {
      const body = await readJson(req);
      const valid =
        typeof body.sessionId === "string" &&
        (body.boot === true || (typeof body.text === "string" && body.text.trim()));
      if (!valid) return sendJson(res, 400, { error: "Нужны sessionId и text или boot" });
      return sendJson(res, 200, await chat(body.sessionId, body));
    }
    if (req.method === "POST" && req.url === "/api/transcribe") {
      const audio = await readBody(req, MAX_AUDIO);
      if (!audio.length) return sendJson(res, 400, { error: "Пустая запись" });
      return sendJson(res, 200, { text: await transcribe(audio, req.headers["content-type"]) });
    }
    if (req.method === "GET" && req.url === "/api/voices") {
      const effects = Object.entries(EFFECTS).map(([id, fx]) => ({ id, name: fx.name }));
      return sendJson(res, 200, { voices: voices(), effects });
    }
    if (req.method === "POST" && req.url === "/api/tts") {
      const { text, voice = "", rate, effect = "none" } = await readJson(req);
      const valid = typeof text === "string" && text.trim() && text.length <= MAX_TTS_CHARS;
      if (!valid || !(effect in EFFECTS)) return sendJson(res, 400, { error: "Нужен text" });
      // Нет такого голоса (или не выбран) — говорим голосом по умолчанию.
      const available = voices();
      const chosen = available.find((v) => v.id === voice) ?? available[0];
      if (!chosen) return sendJson(res, 503, { error: "Нет ни Silero, ни Piper" });
      const wav = await synthesize(text.trim(), chosen.id, rate, effect);
      res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
      return res.end(wav);
    }
    if (req.method === "POST" && req.url === "/api/reset") {
      const body = await readJson(req);
      sessions.delete(body.sessionId);
      return sendJson(res, 200, { ok: true });
    }
    // Сертификат для установки на iPhone (Настройки → Основные → VPN и управление устройством).
    if (req.method === "GET" && req.url === "/tars.crt" && existsSync(CERT_FILE)) {
      res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert" });
      return res.end(readFileSync(CERT_FILE));
    }
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error: "Метод не поддерживается" });
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: describeError(err) });
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net?.family === "IPv4" && !net.internal)
    .map((net) => net.address);
}

// Модель Silero грузится несколько секунд — заранее, чтобы первый ответ не ждал.
if (silero.available()) silero.start().catch((err) => console.error(err.message));

http.createServer(handle).listen(PORT, LISTEN_HOST, () => {
  console.log(`TARS на связи: http://localhost:${PORT}  (${PROVIDER}: ${MODEL})`);
});

if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
  const tls = { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) };
  https.createServer(tls, handle).listen(HTTPS_PORT, "0.0.0.0", () => {
    for (const ip of lanAddresses()) console.log(`  с телефона:   https://${ip}:${HTTPS_PORT}`);
  });
} else if (LISTEN_HOST !== "127.0.0.1") {
  // За Caddy (VPS) HTTPS уже есть — подсказка нужна только дома.
  console.log("  для телефона нужен HTTPS: выполните npm run cert и перезапустите сервер");
}
