// Talking to her out loud: the glue between the microphone (dictation.js) and her chat (chat.js).
// What you say becomes text, and goes to her chat as if you had typed it: her own AI answers, and
// does what you ask (open an app, the music, a reminder…). Also here: the mic button of her chat,
// the little light that shows the mic is open, and the panels for the voice settings (the address
// of a Whisper server, an online service's key, a mic test, where the sound goes before it goes).

import { Dictation } from './dictation.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocalUrl = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(String(url || ''));
const SERVICES = { groq: 'Groq', openai: 'OpenAI' };

const TXT = {
  fr: {
    mic: 'Parler', micTitle: 'Dicter à Capri',
    ok: 'OK', yes: 'Oui, utiliser', no: 'Non, rester local', cancel: 'Annuler',
    consentLine: 'Ton micro envoie le son en ligne ?',
    consent: (where) => `Pour comprendre ce que tu dis, le son de tes phrases est envoyé à ${where} : ce n’est plus hors ligne. Rien n’est envoyé tant que la dictée est éteinte, ni entre deux phrases.`,
    keyLine: (name) => `Colle ta clé ${name}.`, keyHow: 'Elle reste sur ton PC, chiffrée avec ton compte Windows, comme les clés de son chat.', keyTag: 'CLÉ', save: 'Enregistrer', keyNote: 'La même clé sert à son chat si tu choisis ce service.',
    addrLine: 'L’adresse de ton serveur Whisper.', addrHow: 'whisper.cpp (http://127.0.0.1:8080/inference) ou une API compatible OpenAI (http://127.0.0.1:8000/v1).', addrNote: 'Un serveur sur ce PC reste local : le son n’en sort pas.',
    testing: 'Parle, je t’écoute 4 secondes…', testTag: 'MICRO', heard: (text) => `J’ai entendu : « ${text} »`, silence: 'Je n’ai rien entendu. Parle plus près du micro ?', testDone: 'Test du micro',
    errors: {
      denied: ['Le micro est refusé.', 'Autorise le micro pour les applications dans les réglages de confidentialité de Windows.'],
      nomic: ['Je ne trouve pas de micro.', 'Branche-en un, ou choisis-le comme micro par défaut dans Windows.'],
      nokey: ['Il me faut une clé pour ce service.', 'Menu de Capri > Voix > Clé API du service…'],
      nolang: ['Windows ne connaît pas cette langue pour la voix.', 'Ajoute-la dans Windows (Heure et langue > Voix), ou choisis un serveur Whisper ou le service en ligne.'],
      busy: ['Le service est trop sollicité.', 'Réessaie dans un instant.'],
      net: ['Je n’arrive pas à joindre le service de reconnaissance.', 'Vérifie la connexion ou l’adresse du serveur.'],
      nourl: ['Il me manque l’adresse du serveur Whisper.', 'Menu de Capri > Voix > Adresse du serveur…'],
      noengine: ['Cette reconnaissance ne marche pas sur ce système.', 'Choisis un serveur Whisper ou le service en ligne.'],
      other: ['La reconnaissance vocale a échoué.', ''],
    },
  },
  en: {
    mic: 'Talk', micTitle: 'Dictate to Capri',
    ok: 'OK', yes: 'Yes, use it', no: 'No, stay local', cancel: 'Cancel',
    consentLine: 'Send your voice online?',
    consent: (where) => `To understand you, the sound of what you say is sent to ${where}: it is no longer offline. Nothing is sent while dictation is off, nor between two sentences.`,
    keyLine: (name) => `Paste your ${name} key.`, keyHow: 'It stays on your PC, encrypted with your Windows account, like her chat keys.', keyTag: 'KEY', save: 'Save', keyNote: 'The same key serves her chat if you pick that service.',
    addrLine: 'The address of your Whisper server.', addrHow: 'whisper.cpp (http://127.0.0.1:8080/inference) or an OpenAI-compatible API (http://127.0.0.1:8000/v1).', addrNote: 'A server on this PC stays local: the sound never leaves it.',
    testing: 'Say something, I listen for 4 seconds…', testTag: 'MIC', heard: (text) => `I heard: “${text}”`, silence: 'I heard nothing. Closer to the mic?', testDone: 'Mic test',
    errors: {
      denied: ['The microphone is blocked.', 'Allow the mic for apps in Windows’ privacy settings.'],
      nomic: ['I can’t find a microphone.', 'Plug one in, or make it the default mic in Windows.'],
      nokey: ['I need a key for that service.', 'Capri’s menu > Voice > Service API key…'],
      nolang: ['Windows has no voice recognition for this language.', 'Add it in Windows (Time & language > Speech), or pick a Whisper server or the online service.'],
      busy: ['The service is too busy.', 'Try again in a moment.'],
      net: ['I can’t reach the recognition service.', 'Check the connection or the server address.'],
      nourl: ['I’m missing the Whisper server address.', 'Capri’s menu > Voice > Server address…'],
      noengine: ['That recognition doesn’t work on this system.', 'Pick a Whisper server or the online service.'],
      other: ['Voice recognition failed.', ''],
    },
  },
};

export class Talk {
  constructor({ host, chat, panel, guide, capri, brain }) {
    this.host = host;
    this.chat = chat;
    this.panel = panel;
    this.guide = guide;
    this.capri = capri;
    this.brain = brain;
    this.cfg = {};
    this.lang = 'en';
    this.keys = [];
    this.asking = false;
    this.queue = Promise.resolve();
    this.lastError = '';
    this.lastErrorAt = 0;

    this.dictation = new Dictation({ host });
    this.dictation.wakeFree = () => chat.open;
    this.dictation.onState = (state) => this.render(state);
    this.dictation.onText = (res) => this.hear(res);
    this.dictation.onError = (err) => this.fail(err);

    // a small light: the mic is open (always on), or she is listening to you
    this.light = document.createElement('div');
    this.light.className = 'mic';
    this.light.hidden = true;
    this.light.setAttribute('aria-hidden', 'true');
    document.body.append(this.light);

    panel.onMic = () => this.dictation.toggle();
  }

  get t() {
    return TXT[this.lang] || TXT.en;
  }

  // does the sound leave this PC with these settings? Then she asks first, once.
  needsConsent(v = this.cfg) {
    return Boolean(v.enabled) && !v.cloudAsked && (v.engine === 'cloud' || (v.engine === 'server' && !isLocalUrl(v.serverUrl)));
  }

  where(v = this.cfg) {
    return v.engine === 'cloud' ? SERVICES[v.cloud] || SERVICES.groq : v.serverUrl;
  }

  configure(cfg) {
    this.lang = cfg.lang;
    this.keys = cfg.keys || [];
    this.cfg = cfg.voice || {};
    const consent = this.needsConsent();
    this.dictation.configure({ ...this.cfg, enabled: Boolean(this.cfg.enabled) && !consent }, cfg.lang);
    this.panel.setMic(Boolean(this.cfg.enabled) && this.cfg.mode === 'push', this.t);
    this.render(this.dictation.state);
    if (consent) this.consent();
  }

  render(state) {
    const on = this.cfg.enabled && state !== 'off';
    this.light.hidden = !on || (this.cfg.mode !== 'always' && state === 'idle');
    this.light.dataset.state = state;
    this.panel.micState(state);
  }

  // ---------- what you say ----------

  hear(res) {
    this.queue = this.queue.then(() => this.deliver(res)).catch((err) => console.warn('[capri] voice', err));
    return this.queue;
  }

  async deliver({ text, woke }) {
    const { chat, panel } = this;
    if (!chat.open) {
      await chat.start();
      if (!chat.open) return; // she couldn't (her setup came up instead)
    }
    if (!text) return; // only her name: the chat is open, she listens
    for (let i = 0; chat.turn && i < 150; i++) await wait(400); // her answer first
    if (chat.turn) return;
    if (this.cfg.autoSend !== false && !woke) {
      await chat.send(text);
    } else {
      const input = panel.chatInput;
      input.value = `${input.value.trim()} ${text}`.trim();
      input.focus();
    }
  }

  fail({ code, error }) {
    const t = this.t;
    const [line, quote] = t.errors[code] || t.errors.other;
    const key = `${code}|${error}`;
    // the same problem again and again (always-on mic): once is enough
    if (key === this.lastError && performance.now() - this.lastErrorAt < 60000) return;
    this.lastError = key;
    this.lastErrorAt = performance.now();
    this.panel.say({
      kind: 'info', face: 'aside', line, quote: quote || error || '', badge: t.mic,
      actions: [{ id: 'ok', label: t.ok, primary: true }], onAction: () => this.panel.hide(), hold: 9000,
    });
  }

  // ---------- panels ----------

  // the sound goes online: what that means, once, and she goes ahead only if you say yes
  async consent() {
    if (this.asking) return;
    this.asking = true;
    const t = this.t;
    try {
      await this.guide.scene(async () => {
        const id = await this.guide.ask({ face: 'look', line: t.consentLine, quote: t.consent(this.where()), actions: [{ id: 'yes', label: t.yes, primary: true }, { id: 'no', label: t.no }] });
        if (id === 'yes') {
          this.host.setConfig({ voice: { cloudAsked: true } });
          if (this.cfg.engine === 'cloud' && !this.keys.includes(this.cfg.cloud || 'groq')) await this.askKey();
        } else {
          this.host.setConfig({ voice: { engine: 'windows' } });
        }
      });
    } finally {
      this.asking = false;
    }
  }

  async askKey() {
    const t = this.t;
    const provider = this.cfg.cloud || 'groq';
    const got = await this.guide.askText({
      face: 'look', line: t.keyLine(SERVICES[provider]), quote: t.keyHow, secret: true,
      placeholder: 'API key', send: t.save, tag: t.keyTag, note: t.keyNote, actions: [{ id: 'cancel', label: t.cancel }],
    });
    if (!got?.text) return;
    await this.host.voiceSetKey(provider, got.text);
    this.host.setConfig({ voice: {} }); // the overlay learns the key is there
  }

  async askAddress(select) {
    const t = this.t;
    if (select) this.host.setConfig({ voice: { engine: 'server' } });
    const got = await this.guide.askText({
      face: 'look', line: t.addrLine, quote: t.addrHow, placeholder: this.cfg.serverUrl || 'http://127.0.0.1:8080/inference',
      send: t.save, tag: 'URL', note: t.addrNote, actions: [{ id: 'cancel', label: t.cancel }],
    });
    if (got?.text) this.host.setConfig({ voice: { serverUrl: got.text.trim(), engine: 'server' } });
  }

  async test() {
    const t = this.t;
    if (this.needsConsent({ ...this.cfg, enabled: true })) return this.consent();
    this.panel.say({ kind: 'info', face: 'look', line: t.testing, badge: t.testTag, hold: 4600 });
    const res = await this.dictation.test(4000);
    if (!res.ok) return this.fail({ code: res.code, error: res.error });
    this.panel.say({
      kind: 'info', face: res.text ? 'smug' : 'aside', line: res.text ? t.heard(res.text) : t.silence, badge: t.testDone,
      actions: [{ id: 'ok', label: t.ok, primary: true }], onAction: () => this.panel.hide(), hold: 12000,
    });
  }

  // commands from her menu (Voice)
  command(cmd) {
    switch (cmd.name) {
      case 'voiceEngine':
        this.host.setConfig({ voice: { engine: cmd.engine } });
        return true;
      case 'voiceServer':
        this.guide.scene(() => this.askAddress(Boolean(cmd.select)));
        return true;
      case 'voiceKey':
        this.guide.scene(() => this.askKey());
        return true;
      case 'voiceTest':
        this.test();
        return true;
      default:
        return false;
    }
  }
}
