// Выпускает самоподписанный сертификат для HTTPS в локальной сети: certs/cert.pem и certs/key.pem.
// Браузер телефона даёт доступ к микрофону только по HTTPS. Запустите заново, если сменился IP компьютера.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";

const ip = Object.values(os.networkInterfaces())
  .flat()
  .find((n) => n?.family === "IPv4" && !n.internal)?.address;
if (!ip) throw new Error("Не найден IP в локальной сети — компьютер подключён к Wi-Fi?");

// openssl есть в Git для Windows, но не всегда в PATH.
const candidates = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"];
const openssl = candidates.find((c) => c === "openssl" ? hasOpenssl() : existsSync(c));
if (!openssl) throw new Error("Нужен openssl — он входит в Git для Windows");

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

mkdirSync("certs", { recursive: true });
execFileSync(openssl, [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
  "-keyout", "certs/key.pem", "-out", "certs/cert.pem",
  "-subj", `/CN=TARS dev (${ip})`,
  "-addext", `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost`,
  "-addext", "basicConstraints=critical,CA:TRUE",
  "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
  "-addext", "extendedKeyUsage=serverAuth",
], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
console.log(`Сертификат выпущен для ${ip}: certs/cert.pem`);
