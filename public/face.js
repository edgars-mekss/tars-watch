// Мордочка ТАРСа: два светящихся глаза и индикатор голоса на SVG.
// Координаты в точках watchOS: экран Series 5 44 мм — 184×224 pt (368×448 px).

const NS = "http://www.w3.org/2000/svg";
const W = 184;
const EYE_Y = 98;
const EYE_GAP = 34; // от центра экрана до центра глаза
const BARS_Y = 168;
const BAR_COUNT = 5;

export const COLORS = {
  neutral: "#5ce1ff",
  happy: "#5ce1ff",
  confused: "#5ce1ff",
  alert: "#ffb020",
  sad: "#4f8dff",
  error: "#ff4b4b",
};

// Форма глаза: ширина, высота, скругление, верхнее веко (доля высоты),
// наклон века к переносице (pt) и нижнее веко для «улыбающихся» глаз.
const BASE = { w: 44, h: 58, r: 14, lid: 0, tilt: 0, smile: 0 };
const EXPRESSIONS = {
  neutral: {},
  alert: { w: 46, h: 54, r: 10, lid: 0.3, tilt: 9 },
  happy: { w: 46, h: 54, r: 16, smile: 1 },
  sad: { h: 50, lid: 0.32, tilt: -9 },
  confused: { right: { h: 40, lid: 0.22, tilt: -5 } },
  error: { w: 46, h: 30, r: 6, lid: 0.15, tilt: 5 },
};

const rand = (a, b) => a + Math.random() * (b - a);

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export class Face {
  state = "off"; // off | idle | listening | thinking | speaking
  emotion = "neutral";

  #eyes = [];
  #bars = [];
  #color = hexToRgb(COLORS.neutral);
  #brightness = 0.3;
  #look = { x: 0, y: 0 };
  #lookTarget = { x: 0, y: 0 };
  #blink = 1; // 1 — открыт, 0 — закрыт
  #blinkStart = 0;
  #nextBlink = 0;
  #doubleBlink = false;
  #nextSaccade = 0;
  #level = 0; // всплеск громкости на границе слова
  #last = performance.now();

  constructor(svg) {
    const defs = el("defs", {}, svg);
    const glow = el("filter", { id: "glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
    el("feGaussianBlur", { stdDeviation: "3.5", result: "blur" }, glow);
    const merge = el("feMerge", {}, glow);
    el("feMergeNode", { in: "blur" }, merge);
    el("feMergeNode", { in: "SourceGraphic" }, merge);

    for (const side of [-1, 1]) {
      const g = el("g", { filter: "url(#glow)" }, svg);
      this.#eyes.push({
        side,
        p: { ...BASE, h: 3 },
        rect: el("rect", {}, g),
        lid: el("polygon", { fill: "#000" }, g),
        smile: el("ellipse", { fill: "#000" }, g),
      });
    }

    const bars = el("g", { filter: "url(#glow)" }, svg);
    for (let i = 0; i < BAR_COUNT; i++) {
      this.#bars.push({ rect: el("rect", { width: 5, rx: 2.5 }, bars), h: 3, o: 0 });
    }

    requestAnimationFrame((t) => this.#frame(t));
  }

  setState(state) {
    this.state = state;
    this.#nextBlink = performance.now() + rand(600, 2500);
    if (state !== "idle") this.#lookTarget = { x: 0, y: 0 };
  }

  setEmotion(emotion) {
    this.emotion = emotion in EXPRESSIONS ? emotion : "neutral";
  }

  // Вызывается на каждой границе слова при озвучке.
  pulse() {
    this.#level = 1;
  }

  // Громкость голоса Купера, пока робот слушает (0..1).
  setLevel(level) {
    this.#level = Math.max(this.#level, level);
  }

  #target(side) {
    const expr = EXPRESSIONS[this.emotion];
    const t = { ...BASE, ...expr, ...(side > 0 ? expr.right : expr.left) };
    switch (this.state) {
      case "off":
        return { ...BASE, h: 3, r: 1.5 };
      case "listening":
        t.w *= 1.06;
        t.h *= 1.1;
        break;
      case "thinking":
        t.lid = Math.max(t.lid, 0.2);
        break;
    }
    return t;
  }

  #frame(now) {
    const dt = Math.min(0.1, (now - this.#last) / 1000);
    this.#last = now;
    const k = 1 - Math.exp(-dt * 12); // плавное приближение к цели
    const sec = now / 1000;

    this.#updateBlink(now);
    this.#updateLook(now, sec);
    this.#look.x += (this.#lookTarget.x - this.#look.x) * k;
    this.#look.y += (this.#lookTarget.y - this.#look.y) * k;

    const rgbTarget = hexToRgb(COLORS[this.emotion]);
    this.#color = this.#color.map((c, i) => c + (rgbTarget[i] - c) * k);
    const bright = this.state === "off" ? 0.35 : this.state === "listening" ? 1 : 0.9;
    this.#brightness += (bright - this.#brightness) * k;
    const color = `rgb(${this.#color.map((c) => Math.round(c * this.#brightness)).join(",")})`;

    this.#level *= Math.exp(-dt * 6);
    for (const eye of this.#eyes) this.#drawEye(eye, k, color);
    this.#drawBars(sec, k, color);

    requestAnimationFrame((t) => this.#frame(t));
  }

  #updateBlink(now) {
    if (this.state === "off" || this.state === "listening") {
      this.#blink = 1;
      return;
    }
    if (!this.#blinkStart && now >= this.#nextBlink) {
      this.#blinkStart = now;
      this.#doubleBlink = Math.random() < 0.2;
    }
    if (this.#blinkStart) {
      const p = (now - this.#blinkStart) / 170;
      if (p >= 1) {
        this.#blink = 1;
        this.#blinkStart = this.#doubleBlink ? now + 90 : 0;
        this.#doubleBlink = false;
        if (!this.#blinkStart) this.#nextBlink = now + rand(2500, 6500);
      } else if (p > 0) {
        this.#blink = 1 - 0.95 * Math.sin(Math.PI * p);
      }
    }
  }

  #updateLook(now, sec) {
    if (this.state === "thinking") {
      // сканирование: взгляд медленно ходит из стороны в сторону
      this.#lookTarget = { x: 8 * Math.sin(sec * 1.6), y: -4 };
    } else if (this.state === "idle" && now >= this.#nextSaccade) {
      this.#lookTarget = Math.random() < 0.4 ? { x: 0, y: 0 } : { x: rand(-9, 9), y: rand(-6, 5) };
      this.#nextSaccade = now + rand(1500, 5000);
    }
  }

  #drawEye(eye, k, color) {
    const target = this.#target(eye.side);
    for (const key in target) {
      if (key in eye.p) eye.p[key] += (target[key] - eye.p[key]) * k;
    }
    const p = eye.p;
    const speak = this.state === "speaking" ? 1 + 0.06 * this.#level : 1;
    const w = p.w;
    const h = Math.max(2, p.h * this.#blink * speak);
    const cx = W / 2 + eye.side * EYE_GAP + this.#look.x;
    const cy = EYE_Y + this.#look.y;
    const top = cy - h / 2;
    const bottom = cy + h / 2;

    eye.rect.setAttribute("x", cx - w / 2);
    eye.rect.setAttribute("y", top);
    eye.rect.setAttribute("width", w);
    eye.rect.setAttribute("height", h);
    eye.rect.setAttribute("rx", Math.min(p.r, h / 2, w / 2));
    eye.rect.setAttribute("fill", color);

    // Верхнее веко: чёрный многоугольник, срезающий глаз под наклоном.
    const line = top + p.lid * h;
    const tilt = p.tilt * Math.min(1, p.lid * 4);
    const inner = line + tilt; // край у переносицы
    const outer = line - tilt;
    const left = cx - w / 2 - 4;
    const right = cx + w / 2 + 4;
    const [yLeft, yRight] = eye.side < 0 ? [outer, inner] : [inner, outer];
    eye.lid.setAttribute("points", `${left},${top - 40} ${right},${top - 40} ${right},${yRight} ${left},${yLeft}`);

    // Нижнее веко: эллипс, поднимающийся снизу, — глаза-«улыбки».
    const ry = h * 0.55;
    eye.smile.setAttribute("cx", cx);
    eye.smile.setAttribute("cy", bottom + ry - 0.55 * h * p.smile + 1);
    eye.smile.setAttribute("rx", w * 0.8);
    eye.smile.setAttribute("ry", ry);
  }

  #drawBars(sec, k, color) {
    const span = BAR_COUNT * 5 + (BAR_COUNT - 1) * 5;
    this.#bars.forEach((bar, i) => {
      let h = 3;
      let o = 0.3;
      switch (this.state) {
        case "off":
          o = 0;
          break;
        case "listening":
          h = 4 + 5 * (0.5 + 0.5 * Math.sin(sec * 4 - i * 0.9)) + 22 * this.#level * (1 - Math.abs(i - 2) * 0.18);
          o = 0.95;
          break;
        case "thinking":
          o = 0.25 + 0.75 * Math.max(0, Math.sin(sec * 5 - i * 0.7));
          break;
        case "speaking": {
          const noise = 0.5 + 0.25 * Math.sin(sec * 11 + i * 1.7) + 0.25 * Math.sin(sec * 17 - i * 2.3);
          const amp = Math.max(0.35, this.#level);
          h = 4 + 22 * amp * noise * (1 - Math.abs(i - 2) * 0.18);
          o = 0.95;
          break;
        }
      }
      bar.h += (h - bar.h) * k;
      bar.o += (o - bar.o) * k;
      bar.rect.setAttribute("x", W / 2 - span / 2 + i * 10);
      bar.rect.setAttribute("y", BARS_Y - bar.h / 2);
      bar.rect.setAttribute("height", bar.h);
      bar.rect.setAttribute("fill", color);
      bar.rect.setAttribute("opacity", bar.o.toFixed(3));
    });
  }
}
