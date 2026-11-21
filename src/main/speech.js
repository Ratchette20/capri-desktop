'use strict';

// Dictée vocale de Capri : tu parles, ça devient du texte dans son chat, et ce sont les IA qu'elle
// utilise déjà (son modèle de chat, ses actions sur ton PC) qui répondent et agissent.
//
// Le micro est capté dans l'overlay (dictation.js), encodé en WAV 16 kHz mono, et arrive ici :
//   - 'windows' : reconnaissance vocale de Windows (System.Speech), 100 % locale, hors ligne,
//                 sans rien télécharger (il faut la langue installée dans Windows)
//   - 'server'  : un serveur Whisper à toi, en local (whisper.cpp server, faster-whisper-server,
//                 speaches…), adresse dans les réglages
//   - 'cloud'   : Groq (offre gratuite) ou OpenAI, avec la clé que tu colles (chiffrée comme les autres)
// Aussi ici : la touche pour parler (un petit PowerShell qui lit l'état de la touche, même quand
// une autre fenêtre a le focus), l'autorisation du micro pour l'overlay et le sous-menu « Voix ».

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const apps = require('./apps');

const WIN = process.platform === 'win32';

const DEFAULTS = {
  enabled: false,
  engine: 'windows',   // 'windows' | 'server' | 'cloud'
  mode: 'push',        // 'push' (une touche) | 'always' (micro toujours ouvert, écoute continue)
  press: 'hold',       // push : 'hold' (maintenir) | 'toggle' (appuyer pour démarrer, rappuyer pour arrêter)
  key: 'F9',           // une clé de KEYS
  autoSend: true,      // envoyer tout de suite à Capri, sinon ça remplit seulement sa ligne de texte
  wake: true,          // écoute continue : il faut dire « Capri » d'abord (chat fermé)
  cloud: 'groq',       // 'groq' | 'openai'
  cloudAsked: false,   // elle t'a expliqué où part le son, et tu as dit oui
  serverUrl: 'http://127.0.0.1:8080/inference',
  serverModel: 'whisper-1',
  device: '',          // l'entrée audio (deviceId du micro) ; vide : celle par défaut de Windows
  deviceLabel: '',     // son nom, pour la retrouver si l'identifiant change
};

// virtual-key codes (windows.ps1 lit l'état physique de la touche)
const KEYS = { F8: 0x77, F9: 0x78, F10: 0x79, RightCtrl: 0xa3, CapsLock: 0x14, Insert: 0x2d };

const CLOUD = {
  groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', env: 'GROQ_API_KEY' },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'whisper-1', env: 'OPENAI_API_KEY' },
};

// ce que Whisper invente sur du silence
const GHOSTS = /^\W*(?:thanks for watching|thank you for watching|merci d['’]avoir regard|sous-titr|subtitles? by|amara\.org|субтитры|продолжение следует)/i;

const SCRIPT = path.join(__dirname, 'keys.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

let deps = null; // { config, setup, getOverlay }
let poller = null;
let pollerKey = null;
let restarts = 0;
let devices = []; // [{ id, label }] : les entrées audio que l'overlay a vues

const voiceOf = (cfg) => ({ ...DEFAULTS, ...(cfg.voice || {}) });
const isLocalUrl = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(String(url || ''));
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Local ? (pour ce qu'elle dit avant d'envoyer le son quelque part)
function isLocal(v) {
  if (v.engine === 'windows') return true;
  if (v.engine === 'server') return isLocalUrl(v.serverUrl);
  return false;
}

// ---------- les moteurs ----------

async function windowsEngine(wav, lang) {
  if (!WIN) return { ok: false, code: 'noengine', error: 'Windows only' };
  const file = path.join(os.tmpdir(), `capri-voice-${randomUUID()}.wav`);
  fs.writeFileSync(file, wav);
  try {
    const out = await apps.powershell(
      'try { Add-Type -AssemblyName System.Speech; '
      + '$all = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()); '
      + `$info = $all | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq ${ps(lang)} } | Select-Object -First 1; `
      + 'if (-not $info) { "NOLANG|" + (($all | ForEach-Object { $_.Culture.TwoLetterISOLanguageName }) -join ","); exit }; '
      + '$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info); '
      + '$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); '
      + `$e.SetInputToWaveFile(${ps(file)}); `
      + '$parts = @(); while ($true) { $r = $e.Recognize(); if (-not $r) { break }; $parts += $r.Text }; '
      + '$e.Dispose(); "OK|" + ($parts -join " ") } catch { "ERR|" + $_.Exception.Message }',
      60000,
    );
    const [tag, ...rest] = out.split('|');
    const body = rest.join('|').trim();
    if (tag === 'OK') return { ok: true, text: body };
    if (tag === 'NOLANG') return { ok: false, code: 'nolang', error: body };
    return { ok: false, error: body || out };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

// POST multipart d'un fichier audio : API « OpenAI » (audio/transcriptions), ou whisper.cpp (/inference)
async function whisperPost(url, { key, model, wav, lang, cpp }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  if (!cpp) form.append('model', model);
  if (lang) form.append('language', lang);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const res = await fetch(url, {
    method: 'POST',
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body.slice(0, 200) || `answered ${res.status}`;
    try {
      const err = JSON.parse(body).error;
      message = typeof err === 'string' ? err : err?.message || message;
    } catch {
      // not JSON
    }
    return { ok: false, code: res.status === 401 ? 'nokey' : res.status === 429 ? 'busy' : null, error: message };
  }
  const json = await res.json().catch(() => ({}));
  return { ok: true, text: String(json.text || '').trim() };
}

async function cloudEngine(v, wav, lang) {
  const p = CLOUD[v.cloud] || CLOUD.groq;
  const key = deps.setup.openKeys(deps.config.load().apiKeys)[v.cloud] || process.env[p.env] || '';
  if (!key) return { ok: false, code: 'nokey', error: `no API key for ${p.label}` };
  return whisperPost(`${p.url}/audio/transcriptions`, { key, model: p.model, wav, lang }).catch((err) => ({ ok: false, code: 'net', error: err.message }));
}

async function serverEngine(v, wav, lang) {
  let url = String(v.serverUrl || '').trim().replace(/\/+$/, '');
  if (!url) return { ok: false, code: 'nourl', error: 'no server address' };
  const cpp = /\/inference$/.test(url);
  if (!cpp && !/\/audio\/transcriptions$/.test(url)) url += `${/\/v1$/.test(url) ? '' : '/v1'}/audio/transcriptions`;
  return whisperPost(url, { model: v.serverModel || 'whisper-1', wav, lang, cpp }).catch((err) => ({ ok: false, code: 'net', error: err.message }));
}

async function transcribe({ wav, lang = 'en' } = {}) {
  const v = voiceOf(deps.config.load());
  if (!wav || !(wav.byteLength > 44)) return { ok: false, code: 'empty', error: 'no audio' };
  const buf = Buffer.from(wav);
  const two = String(lang).slice(0, 2).toLowerCase();
  const res = v.engine === 'cloud' ? await cloudEngine(v, buf, two)
    : v.engine === 'server' ? await serverEngine(v, buf, two)
      : await windowsEngine(buf, two);
  if (res.ok && GHOSTS.test(res.text)) res.text = '';
  return { ...res, local: isLocal(v) };
}

// ---------- la touche pour parler ----------

function stopPoller() {
  const child = poller;
  poller = null;
  pollerKey = null;
  child?.kill();
}

// Un petit PowerShell lit l'état de la touche (même quand une autre fenêtre a le focus) : "down" / "up".
function syncKeys() {
  const v = voiceOf(deps.config.load());
  const vk = WIN && v.enabled && v.mode === 'push' ? KEYS[v.key] : null;
  if (!vk) {
    stopPoller();
    return;
  }
  if (poller && pollerKey === vk) return;
  stopPoller();
  pollerKey = vk;
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT, '-Vk', String(vk), '-ParentPid', String(process.pid),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  poller = child;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const overlay = deps.getOverlay();
    if (overlay && !overlay.isDestroyed() && (line === 'down' || line === 'up')) overlay.webContents.send('voice:key', { down: line === 'down' });
  });
  child.on('exit', () => {
    if (poller !== child) return;
    poller = null;
    if (restarts++ < 3) setTimeout(syncKeys, 3000);
  });
}

// ---------- branchement ----------

function init({ ipcMain, session, config, setup, getOverlay, refresh }) {
  deps = { config, setup, getOverlay, refresh };

  // le micro, pour l'overlay et seulement lui (le reste comme avant)
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media') return callback(true);
    const types = details?.mediaTypes || [];
    callback(wc === getOverlay()?.webContents && types.every((t) => t === 'audio'));
  });
  // (wc peut être nul pour une simple vérification, comme celle de enumerateDevices : sans ça, pas de noms de micros)
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => (
    permission !== 'media' || ((!wc || wc === getOverlay()?.webContents) && (!details?.mediaType || details.mediaType === 'audio'))));

  ipcMain.handle('voice:transcribe', (_e, req) => transcribe(req).catch((err) => ({ ok: false, error: err.message })));
  ipcMain.handle('voice:state', () => ({
    platform: process.platform,
    local: isLocal(voiceOf(config.load())),
    provider: (CLOUD[voiceOf(config.load()).cloud] || CLOUD.groq).label,
  }));
  // les entrées audio vues par l'overlay (les noms ne sont connus qu'après une autorisation du micro)
  ipcMain.handle('voice:devices', (_e, list) => {
    const next = (Array.isArray(list) ? list : [])
      .filter((d) => d && typeof d.id === 'string')
      .map((d) => ({ id: d.id, label: String(d.label || '').slice(0, 120) }));
    if (JSON.stringify(next) !== JSON.stringify(devices)) {
      devices = next;
      deps.refresh?.(); // le menu se refait avec la liste
    }
    return { ok: true };
  });
  // la clé du service en ligne : la même que celle de son chat pour ce service, chiffrée de la même façon
  ipcMain.handle('voice:setKey', (_e, { provider, key }) => {
    if (!CLOUD[provider] || !String(key || '').trim()) return { ok: false };
    const cfg = config.load();
    config.save({ apiKeys: { ...cfg.apiKeys, [provider]: setup.sealKey(String(key).trim()) } });
    return { ok: true };
  });
  syncKeys();
}

// Un patch { voice: { engine } } vient partiel (du menu ou de l'overlay) : fusionné avec le reste.
function mergePatch(patch, cfg) {
  return patch && patch.voice ? { ...patch, voice: { ...voiceOf(cfg), ...patch.voice } } : patch;
}

function onConfig(patch) {
  if (patch && 'voice' in patch) syncKeys();
}

function stop() {
  stopPoller();
}

// ---------- le sous-menu « Voix » ----------

const TXT = {
  fr: {
    voice: 'Voix (dicter à Capri)', enabled: 'Dictée vocale',
    engine: 'Reconnaissance', windows: 'Windows (local, hors ligne)', server: 'Serveur Whisper local…', cloud: 'En ligne (Groq / OpenAI)',
    mode: 'Quand parler', push: 'Avec une touche', always: 'Micro toujours ouvert (écoute continue)',
    key: 'Touche', press: 'Style de la touche', hold: 'Maintenir pour parler', toggle: 'Appuyer pour démarrer / arrêter',
    autoSend: 'Envoyer à Capri tout de suite', wake: 'Écoute continue : dire « Capri » d’abord',
    service: 'Service en ligne', apiKey: 'Clé API du service…', address: 'Adresse du serveur…', test: 'Tester le micro',
    keys: { F8: 'F8', F9: 'F9', F10: 'F10', RightCtrl: 'Ctrl droite', CapsLock: 'Verr. Maj', Insert: 'Inser' },
    input: 'Entrée audio (micro)', defaultInput: 'Celle par défaut de Windows', refreshInputs: 'Actualiser la liste', noInputs: 'Active la dictée pour voir les micros', unplugged: ' (absent)',
  },
  en: {
    voice: 'Voice (dictate to Capri)', enabled: 'Voice dictation',
    engine: 'Recognition', windows: 'Windows (local, offline)', server: 'Local Whisper server…', cloud: 'Online (Groq / OpenAI)',
    mode: 'When to talk', push: 'With a key', always: 'Mic always on (continuous listening)',
    key: 'Key', press: 'Key style', hold: 'Hold to talk', toggle: 'Press to start / stop',
    autoSend: 'Send to Capri right away', wake: 'Continuous listening: say “Capri” first',
    service: 'Online service', apiKey: 'Service API key…', address: 'Server address…', test: 'Test the mic',
    keys: { F8: 'F8', F9: 'F9', F10: 'F10', RightCtrl: 'Right Ctrl', CapsLock: 'Caps Lock', Insert: 'Insert' },
    input: 'Audio input (microphone)', defaultInput: 'Windows default', refreshInputs: 'Refresh the list', noInputs: 'Turn dictation on to see the mics', unplugged: ' (missing)',
  },
};

// Items à insérer dans le menu de Capri. update(patch): change un réglage de voix; command(name, payload): à l'overlay.
function menu({ cfg, lang, update, command }) {
  const t = TXT[lang] || TXT.en;
  const v = voiceOf(cfg);
  const set = (patch) => update({ voice: patch });
  const radio = (label, current, value, key) => ({ label, type: 'radio', checked: current === value, click: () => set({ [key]: value }) });
  return {
    label: t.voice,
    submenu: [
      { label: t.enabled, type: 'checkbox', checked: v.enabled, click: (item) => set({ enabled: item.checked }) },
      { type: 'separator' },
      { label: t.engine, enabled: false },
      { label: t.windows, type: 'radio', checked: v.engine === 'windows', enabled: WIN, click: () => set({ engine: 'windows' }) },
      { label: t.server, type: 'radio', checked: v.engine === 'server', click: () => command('voiceServer', { select: true }) },
      { label: t.cloud, type: 'radio', checked: v.engine === 'cloud', click: () => command('voiceEngine', { engine: 'cloud' }) },
      {
        label: t.service,
        submenu: Object.entries(CLOUD).map(([id, p]) => ({ label: p.label, type: 'radio', checked: v.cloud === id, click: () => set({ cloud: id }) })),
      },
      { label: t.apiKey, click: () => command('voiceKey') },
      { type: 'separator' },
      {
        label: t.input,
        submenu: [
          { label: t.defaultInput, type: 'radio', checked: !v.device, click: () => set({ device: '', deviceLabel: '' }) },
          ...devices.filter((d) => d.id !== 'default' && d.id !== 'communications').map((d) => ({
            label: d.label || d.id.slice(0, 8), type: 'radio', checked: v.device === d.id, click: () => set({ device: d.id, deviceLabel: d.label }),
          })),
          // choisi mais débranché
          ...(v.device && !devices.some((d) => d.id === v.device)
            ? [{ label: `${v.deviceLabel || v.device.slice(0, 8)}${t.unplugged}`, type: 'radio', checked: true, enabled: false }] : []),
          ...(devices.length ? [] : [{ label: t.noInputs, enabled: false }]),
          { type: 'separator' },
          { label: t.refreshInputs, click: () => command('voiceDevices') },
        ],
      },
      { type: 'separator' },
      { label: t.mode, enabled: false },
      radio(t.push, v.mode, 'push', 'mode'),
      radio(t.always, v.mode, 'always', 'mode'),
      { type: 'separator' },
      {
        label: t.key,
        enabled: WIN && v.mode === 'push',
        submenu: Object.keys(KEYS).map((k) => radio(t.keys[k], v.key, k, 'key')),
      },
      {
        label: t.press,
        enabled: v.mode === 'push',
        submenu: [radio(t.hold, v.press, 'hold', 'press'), radio(t.toggle, v.press, 'toggle', 'press')],
      },
      { label: t.wake, type: 'checkbox', checked: v.wake, enabled: v.mode === 'always', click: (item) => set({ wake: item.checked }) },
      { label: t.autoSend, type: 'checkbox', checked: v.autoSend, click: (item) => set({ autoSend: item.checked }) },
      { type: 'separator' },
      { label: t.address, click: () => command('voiceServer', {}) },
      { label: t.test, click: () => command('voiceTest') },
    ],
  };
}

module.exports = { DEFAULTS, KEYS, init, mergePatch, onConfig, menu, stop, voiceOf, transcribe };
