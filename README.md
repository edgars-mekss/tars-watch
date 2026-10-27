# TARS: a voice AI robot for Apple Watch

🇷🇺 [Описание на русском](README.ru.md)

> **Status: web prototype, work in progress.** Built with Claude Code. The watchOS (SwiftUI) port comes next.

A small robot character that lives on your wrist. You tap the screen and talk to it. It answers out loud while its glowing eyes show what it is doing: listening, thinking, speaking, or reacting with an emotion.

The robot plays **TARS** from *Interstellar*: a laconic, deadpan military robot. Like in the film, its personality has settings in percent. Say *"TARS, set humor to 60%"* and it confirms, its manner changes, and the new value appears on the watch face.

The robot speaks Russian.

Apple Watch apps can only be built in Xcode on a Mac. So the design, animation, personality and conversation logic are first worked out in a browser, in a 368×448 frame that matches the Apple Watch Series 5 (44 mm) screen. All of this carries over to the watchOS app.

## Features

- **Animated face.** Two glowing eyes drawn in SVG. They blink, glance around, widen while listening and scan side to side while thinking. Five voice bars react to your voice while the robot listens and pulse with its words while it speaks.
- **Emotions.** The reply carries an emotion (neutral, alert, happy, confused, sad), shown through eyelid shapes and color.
- **Voice in.** The browser records the phrase and detects its end after 1.2 s of silence. The server sends it to Whisper (`whisper-large-v3-turbo`) and gets the text back in about 0.7 s.
- **Voice out.** Speech synthesis in the browser, with the pitch lowered to sound more robotic.
- **Personality settings.** Humor, sarcasm and honesty (defaults 0 / 0 / 90%). They change by voice and persist through the conversation.
- **Short, wrist-sized answers.** One or two sentences, plain spoken language, no made-up data: with no sensors or internet, the robot says it has no data instead of inventing the weather or your pulse.
- **Debug panel.** Text input instead of voice, voice and pitch controls, and a preview of every animation state and emotion.

## How it works

```
tap ─► LISTENING ─────────► THINKING ─────────────────────► SPEAKING ─► IDLE
       mic recording         /api/transcribe → Whisper        speech     blinks,
       (voice bars react)    /api/chat → LLM → JSON reply     synthesis  looks around
```

The language model returns structured JSON, not free text:

```json
{ "reply": "Humor set to sixty percent.", "emotion": "neutral", "humor": 60, "sarcasm": 0, "honesty": 90 }
```

So one response drives the voice, the face and the settings display at once.

| File | Role |
|---|---|
| `persona.js` | Character: system prompt, default settings, reply schema. Kept in one place so it moves to the watch app unchanged. |
| `server.js` | Small Node.js server with no framework. Serves the prototype and proxies speech recognition and chat, so the API key never reaches the browser. |
| `public/face.js` | The face: eyes, eyelids, emotions, blinking, voice bars. |
| `public/voice.js` | Mic recording with silence detection, and speech synthesis. |
| `public/app.js` | State machine (off → idle → listening → thinking → speaking), taps, debug panel. |

## Decisions and measurements

- **A free open model in the cloud, not on the watch.** The Series 5 has about 1 GB of RAM and no Neural Engine. Even a 0.5B model would run at roughly a word per second and drain the battery. So the watch only handles the face, mic and sound, and the "brain" runs in the cloud.
- **Model chosen by testing.** On the same questions `qwen3.8-27b` made Russian mistakes, while `gpt-oss-120b` stayed correct and kept to the character. Current setup: `openai/gpt-oss-120b` on Groq's free tier, with low reasoning effort. Replies take 0.3–0.9 s.
- **Built for free-tier limits.** The free tier allows 8,000 tokens per minute, and a request costs about 1.2–1.7k tokens. So only the last 16 messages go to the model and the reply length is capped. On a rate-limit error the server waits a few seconds and retries instead of failing.
- **Provider-agnostic.** Any OpenAI-compatible API (Groq, OpenRouter, Mistral, a local Ollama) can be used by changing `.env`. Claude is supported as a paid option.
- **Whisper instead of the browser's speech API.** It works in any browser, not only Chrome and Edge. It is also how speech will be recognized on the watch.
- **Whisper hallucination filter.** On silence Whisper tends to "hear" video subtitle credits, so such phrases are dropped.

## Running it

Requires Node.js 21.7+ and a free [Groq API key](https://console.groq.com/keys).

```bash
npm install
cp .env.example .env   # then put your key into LLM_API_KEY=
npm start              # http://localhost:3000
```

Tap the watch screen to switch TARS on, then tap again and speak. Space works too.

## Roadmap

- [ ] Demo video
- [ ] HTTPS, so the prototype runs on a phone over Wi-Fi with the microphone
- [ ] watchOS app in SwiftUI (watchOS 10) with the same face, personality and server
- [ ] Instant on-device commands (settings, time, status report) that work without a network

## Credits

TARS is a character from the film *Interstellar* (2014). This is a non-commercial fan project and is not affiliated with the film's rights holders.

Author: Edgar Meksh ([edgars-mekss](https://github.com/edgars-mekss)).
