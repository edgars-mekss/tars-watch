// Локальный сервер: отдаёт веб-прототип из public/ и проксирует разговор в языковую модель,
// чтобы ключ не попадал в браузер. Провайдер выбирается в .env (LLM_PROVIDER).
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { BOOT_MESSAGE, EMOTIONS, REPLY_SCHEMA, SYSTEM_PROMPT } from "./persona.js";
import { EFFECTS, MONOTONE_ARGS, robotize } from "./robotize.js";

try {
  process.loadEnvFile(); // ключи и выбор модели из .env
} catch {
  // .env нет — берём переменные окружения
}

const PORT = Number(process.env.PORT) || 3000;
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

// Озвучка мужским голосом: Piper — локально и бесплатно. По умолчанию берём из «Помощника» (D:\Project3).
const PIPER_EXE = process.env.PIPER_EXE ?? "D:/Project3/runtime/piper/piper.exe";
const PIPER_VOICES_DIR = process.env.PIPER_VOICES ?? "D:/Project3/runtime/voices";
const PIPER_NAMES = { dmitri: "Дмитрий", denis: "Денис", ruslan: "Руслан" };
const MAX_TTS_CHARS = 600;

const piperModel = (voice) => path.join(PIPER_VOICES_DIR, `ru_RU-${voice}-medium.onnx`);

function piperVoices() {
  if (!existsSync(PIPER_EXE)) return [];
  return Object.entries(PIPER_NAMES)
    .filter(([id]) => existsSync(piperModel(id)))
    .map(([id, name]) => ({ id, name }));
}

async function synthesize(text, voice, rate = 1, effect = "none") {
  const out = path.join(os.tmpdir(), `tars-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const lengthScale = (1 / Math.min(2, Math.max(0.5, Number(rate) || 1))).toFixed(2);
  await new Promise((resolve, reject) => {
    const args = ["--model", piperModel(voice), "--output_file", out, "--length_scale", lengthScale, "--quiet"];
    if (EFFECTS[effect]?.monotone) args.push(...MONOTONE_ARGS);
    const piper = spawn(PIPER_EXE, args, {
      cwd: path.dirname(PIPER_EXE),
      windowsHide: true,
    });
    piper.on("error", reject);
    piper.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Piper завершился с кодом ${code}`))));
    piper.stdin.end(text, "utf8");
  });
  try {
    return robotize(await readFile(out), effect);
  } finally {
    await rm(out, { force: true });
  }
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

async function handle(req, res) {
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
      return sendJson(res, 200, { piper: piperVoices(), effects });
    }
    if (req.method === "POST" && req.url === "/api/tts") {
      const { text, voice, rate, effect = "none" } = await readJson(req);
      const valid = typeof text === "string" && text.trim() && text.length <= MAX_TTS_CHARS;
      if (!valid || !(voice in PIPER_NAMES) || !(effect in EFFECTS)) {
        return sendJson(res, 400, { error: "Нужны text и voice" });
      }
      if (!piperVoices().some((v) => v.id === voice)) return sendJson(res, 503, { error: "Piper не найден" });
      const wav = await synthesize(text.trim(), voice, rate, effect);
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

http.createServer(handle).listen(PORT, "0.0.0.0", () => {
  console.log(`TARS на связи: http://localhost:${PORT}  (${PROVIDER}: ${MODEL})`);
});

if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
  const tls = { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) };
  https.createServer(tls, handle).listen(HTTPS_PORT, "0.0.0.0", () => {
    for (const ip of lanAddresses()) console.log(`  с телефона:   https://${ip}:${HTTPS_PORT}`);
  });
} else {
  console.log("  для телефона нужен HTTPS: выполните npm run cert и перезапустите сервер");
}
