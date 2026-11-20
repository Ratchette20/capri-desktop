// La dictée de Capri : le micro, dans l'overlay. Deux façons de parler :
//   - 'push'   : une touche (maintenue, ou une pression pour démarrer et une pour arrêter), ou le
//                bouton micro de son panneau ;
//   - 'always' : micro toujours ouvert, écoute continue : une détection de voix coupe ce que tu dis
//                en phrases, envoyées une à une (avec « Capri » d'abord, si tu l'as demandé).
// Le son est mis en WAV 16 kHz mono et envoyé au moteur choisi (speech.js, côté main). Le texte
// arrive à onText(text) : app.js le donne à son chat, et c'est son IA qui répond et fait les
// actions (ouvrir une appli, la musique, un rappel…), comme si tu l'avais tapé.

const RATE = 16000;
const CHUNK = 4096;
const PRE_ROLL_MS = 350;   // ce qui précède le début détecté d'une phrase
const END_SILENCE_MS = 900; // le silence qui finit une phrase (écoute continue)
const MIN_SPEECH_MS = 450;
const MAX_SPEECH_MS = 30000;
const MIN_PUSH_MS = 250;    // plus court : un appui par erreur
const FLOOR = 0.012;        // niveau minimum pour compter comme voix

// "Capri, ouvre Spotify" -> "ouvre Spotify" ; null si la phrase ne commence pas par son nom
const WAKE = /^\W*(?:(?:hey|hé|salut|ok|okay|dis|oye|ei|привет)\s+)?(?:capri|kapri|capry|capris|каприз?|капри)\b[\s,.:;!?-]*/i;

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return buffer;
}

// vers 16 kHz, par moyenne (assez bon pour la parole)
function downsample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

export class Dictation {
  constructor({ host }) {
    this.host = host;
    this.cfg = { enabled: false, mode: 'push', press: 'hold', wake: true };
    this.lang = 'en';
    this.state = 'off';   // off | idle (le micro est ouvert, rien ne se dit) | listening | working
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.rate = 48000;
    this.buffers = [];    // ce qui s'enregistre pour la phrase en cours
    this.pre = [];        // le début glissant, pour ne pas manger le début d'une phrase
    this.floor = FLOOR;   // bruit ambiant estimé
    this.speaking = false;
    this.lastVoice = 0;
    this.startedAt = 0;
    this.pushOn = false;  // une prise de parole à la touche est en cours
    this.pending = 0;     // phrases en cours de reconnaissance
    this.level = 0;       // 0..1, pour le bouton micro
    this.onState = null;  // (state) => void
    this.onText = null;   // async ({ text, via }) => void
    this.onError = null;  // ({ code, error }) => void
    this.canHear = null;  // () => bool : faux pendant qu'elle parle (ses propres sons)
    this.wakeFree = null; // () => bool : vrai quand son chat est ouvert (inutile de dire « Capri »)
    host.onVoiceKey?.(({ down }) => this.key(down));
  }

  // réglages (voice de la config) et langue de reconnaissance
  configure(voice = {}, lang = this.lang) {
    const before = this.cfg;
    this.cfg = { ...this.cfg, ...voice };
    this.lang = lang;
    const wantOpen = this.cfg.enabled && this.cfg.mode === 'always';
    if (!this.cfg.enabled) this.close();
    else if (wantOpen && !this.stream) this.open().catch(() => {});
    else if (!wantOpen && this.stream && !this.pushOn) this.close();
    if (before.mode !== this.cfg.mode) this.cancelUtterance();
  }

  set(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState?.(state);
  }

  // ---------- le micro ----------

  async open() {
    if (this.stream || this.opening) return;
    this.opening = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this.opening = false;
      this.onError?.({ code: err.name === 'NotAllowedError' ? 'denied' : 'nomic', error: err.message });
      this.set('off');
      return;
    }
    this.opening = false;
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    const source = this.ctx.createMediaStreamSource(this.stream);
    // (un ScriptProcessor : un AudioWorklet voudrait un script en blob:, que sa politique de sécurité refuse)
    this.node = this.ctx.createScriptProcessor(CHUNK, 1, 1);
    this.node.onaudioprocess = (e) => this.process(new Float32Array(e.inputBuffer.getChannelData(0)));
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // ça doit être relié pour tourner, pas pour s'entendre
    source.connect(this.node).connect(mute).connect(this.ctx.destination);
    this.set('idle');
  }

  close() {
    this.cancelUtterance();
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.pushOn = false;
    this.set('off');
  }

  cancelUtterance() {
    this.buffers = [];
    this.pre = [];
    this.speaking = false;
  }

  // ---------- ce qui arrive du micro ----------

  process(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    this.level = Math.min(1, rms * 8);
    const now = performance.now();
    const chunkMs = (samples.length / this.rate) * 1000;

    if (this.pushOn) {
      this.buffers.push(samples);
      return;
    }
    if (this.cfg.mode !== 'always' || !this.cfg.enabled) return;
    // ses propres sons (blips, lightning…) ne sont pas ta voix
    if (this.canHear && !this.canHear()) {
      this.cancelUtterance();
      return;
    }
    const threshold = Math.max(FLOOR, this.floor * 3);
    const voice = rms > threshold;
    if (!voice && !this.speaking) this.floor = this.floor * 0.95 + rms * 0.05; // le bruit ambiant

    if (!this.speaking) {
      this.pre.push(samples);
      while (this.pre.length * chunkMs > PRE_ROLL_MS) this.pre.shift();
      if (voice) {
        this.speaking = true;
        this.startedAt = now;
        this.lastVoice = now;
        this.buffers = [...this.pre];
        this.pre = [];
        this.set('listening');
      }
      return;
    }
    this.buffers.push(samples);
    if (voice) this.lastVoice = now;
    const talked = now - this.startedAt;
    if (now - this.lastVoice > END_SILENCE_MS || talked > MAX_SPEECH_MS) {
      const spoke = this.lastVoice - this.startedAt;
      const chunks = this.buffers;
      this.cancelUtterance();
      this.set(this.pending ? 'working' : 'idle');
      if (spoke >= MIN_SPEECH_MS) this.recognize(chunks, 'always');
    }
  }

  // ---------- à la touche ----------

  // la touche (main.js la lit): maintenue, ou une pression qui démarre et une qui arrête
  key(down) {
    if (!this.cfg.enabled || this.cfg.mode !== 'push') return;
    if (this.cfg.press === 'toggle') {
      if (down) this.toggle();
    } else if (down) {
      this.startPush();
    } else {
      this.stopPush();
    }
  }

  // le bouton micro de son panneau, ou la touche en mode « une pression »
  toggle() {
    if (this.pushOn) this.stopPush();
    else this.startPush();
  }

  async startPush() {
    if (this.pushOn) return;
    this.pushOn = true; // tout de suite, pour que le relâché d'une touche rapide soit pris en compte
    this.buffers = [];
    if (!this.stream) await this.open();
    if (!this.stream) {
      this.pushOn = false;
      return;
    }
    if (!this.pushOn) {
      // relâchée pendant l'ouverture du micro
      if (this.cfg.mode !== 'always') this.close();
      return;
    }
    this.startedAt = performance.now();
    this.set('listening');
  }

  stopPush() {
    if (!this.pushOn) return;
    this.pushOn = false;
    const chunks = this.buffers;
    const ms = performance.now() - this.startedAt;
    this.buffers = [];
    // le micro ne reste ouvert que pour l'écoute continue
    if (this.cfg.mode !== 'always') this.close();
    else this.set('idle');
    if (ms >= MIN_PUSH_MS && chunks.length) this.recognize(chunks, 'push');
    else this.set(this.stream ? 'idle' : 'off');
  }

  // Un enregistrement de quelques secondes, pour « Tester le micro » : résout avec { ok, text } ou { ok: false, ... }
  async test(ms = 4000) {
    const had = Boolean(this.stream);
    if (!had) await this.open();
    if (!this.stream) return { ok: false, code: 'nomic' };
    const saved = this.pushOn;
    this.pushOn = true;
    this.buffers = [];
    this.set('listening');
    await new Promise((r) => setTimeout(r, ms));
    this.pushOn = saved;
    const chunks = this.buffers;
    this.buffers = [];
    if (!had && this.cfg.mode !== 'always') this.close();
    else this.set('idle');
    return this.transcribe(chunks);
  }

  // ---------- reconnaissance ----------

  toWav(chunks) {
    let length = 0;
    for (const c of chunks) length += c.length;
    const all = new Float32Array(length);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    return encodeWav(downsample(all, this.rate, RATE), RATE);
  }

  transcribe(chunks) {
    return this.host.voiceTranscribe({ wav: this.toWav(chunks), lang: this.lang });
  }

  async recognize(chunks, via) {
    this.pending += 1;
    this.set('working');
    let res;
    try {
      res = await this.transcribe(chunks);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    this.pending -= 1;
    this.set(this.stream ? (this.speaking ? 'listening' : this.pending ? 'working' : 'idle') : 'off');
    if (!res?.ok) {
      this.onError?.({ code: res?.code, error: res?.error });
      return;
    }
    let text = String(res.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    // écoute continue : sans « Capri » d'abord, ce n'est pas pour elle (une conversation à côté, une vidéo…)
    if (via === 'always' && this.cfg.wake && !this.wakeFree?.()) {
      if (!WAKE.test(text)) return;
      text = text.replace(WAKE, '').trim();
      if (!text) {
        await this.onText?.({ text: '', via, woke: true }); // juste son nom : son chat s'ouvre (app.js)
        return;
      }
    }
    await this.onText?.({ text, via });
  }
}

export { WAKE };
