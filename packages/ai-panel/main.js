/* Manifest panel (mixed context: browser + Node.js). Receives IR from the Figma plugin and runs the ExtendScript builder. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 7531;
const MAX_BODY = 1024 * 1024 * 1024;
const ROOT = path.join(os.tmpdir(), 'manifest');
const ASSETS = path.join(ROOT, 'assets');
const SESSION = path.join(ROOT, 'session.json');
const ASSET_NAME = /^[0-9a-f]{16,64}\.(png|jpg|gif)$/i;

fs.mkdirSync(ASSETS, { recursive: true });

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const importEl = document.getElementById('import');

function log(line) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function extensionPath() {
  const p = decodeURI(window.__adobe_cep__.getSystemPath('extension'));
  return p.replace(/^file:\/{2,3}/, process.platform === 'win32' ? '' : '/');
}

const BUILDER = path.join(extensionPath(), 'jsx', 'builder.jsx').replace(/\\/g, '/');

function evalScript(code) {
  return new Promise((resolve) => window.__adobe_cep__.evalScript(code, resolve));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isHex(h) {
  return typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h);
}

function isCmyk(c) {
  return Array.isArray(c) && c.length === 4 && c.every((v) => typeof v === 'number' && isFinite(v));
}

function pruneAssets() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(ASSETS)) {
      const file = path.join(ASSETS, name);
      const st = fs.statSync(file);
      if (now - st.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(file);
    }
  } catch (e) {
    /* ignore */
  }
}

function writeSession(token) {
  fs.writeFileSync(SESSION, JSON.stringify({ token, port: PORT, pid: process.pid }));
}

function readSessionToken() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION, 'utf8'));
    if (s.port === PORT && typeof s.token === 'string' && s.token.length >= 16) return s.token;
  } catch (e) {
    /* ignore */
  }
  return '';
}

let token = crypto.randomBytes(24).toString('hex');
let ownsServer = false;

function authorized(req) {
  const header = req.headers['x-manifest-token'];
  return header && header === token;
}

let queue = Promise.resolve();

async function build(body) {
  const doc = JSON.parse(body.toString('utf8'));
  doc.assetDir = ASSETS.replace(/\\/g, '/');
  const json = JSON.stringify(doc).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const file = path.join(ROOT, `payload-${Date.now()}.json`);
  fs.writeFileSync(file, json, 'utf8');

  log(`Building ${doc.artboards.length} artboard(s)…`);
  const started = Date.now();
  const out = await evalScript(`$.evalFile(${JSON.stringify(BUILDER)}, 0); f2aBuild(${JSON.stringify(file.replace(/\\/g, '/'))});`);
  fs.unlink(file, () => {});
  if (!out || out === 'EvalScript error.') throw new Error('ExtendScript error');
  const result = JSON.parse(out);
  log(result.ok ? `Done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${result.created} objects` : `Error: ${result.error}`);
  return result;
}

async function convert(body) {
  const req = JSON.parse(body.toString('utf8'));
  const clean = {
    rgb: (req.rgb || []).filter(isHex),
    proof: (req.proof || [])
      .filter((p) => p && isCmyk(p.cmyk) && isHex(p.hex))
      .map((p) => ({ cmyk: p.cmyk, hex: p.hex })),
  };
  const out = await evalScript(`$.evalFile(${JSON.stringify(BUILDER)}, 0); f2aConvert(${JSON.stringify(JSON.stringify(clean))});`);
  if (!out || out === 'EvalScript error.') throw new Error('ExtendScript error');
  return JSON.parse(out);
}

function unzipStore(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = dv.getUint16(off + 10, true);
    const comp = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extra = dv.getUint16(off + 30, true);
    const comment = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = Buffer.from(buf.subarray(off + 46, off + 46 + nameLen)).toString('utf8');
    const locName = dv.getUint16(localOff + 26, true);
    const locExtra = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + locName + locExtra;
    if (method !== 0) throw new Error('compressed .manifest is not supported');
    files.push({ name, data: Buffer.from(buf.subarray(start, start + comp)) });
    off += 46 + nameLen + extra + comment;
  }
  return files;
}

async function importF2a(buf) {
  const files = unzipStore(buf);
  const docFile = files.find((f) => /(^|\/)document\.json$/i.test(f.name));
  if (!docFile) throw new Error('document.json missing from .manifest');
  const doc = JSON.parse(docFile.data.toString('utf8'));
  for (const file of files) {
    const base = path.posix.basename(file.name.replace(/\\/g, '/'));
    if (!ASSET_NAME.test(base)) continue;
    fs.writeFileSync(path.join(ASSETS, base), file.data);
  }
  return build(Buffer.from(JSON.stringify(doc), 'utf8'));
}

async function handle(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return send(res, 403, { ok: false, error: 'origin not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Manifest-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.end();

  try {
    if (req.method === 'GET' && req.url === '/ping') {
      return send(res, 200, { ok: true, app: 'illustrator', token });
    }

    if (!authorized(req)) return send(res, 401, { ok: false, error: 'missing or invalid token' });

    const asset = req.url.match(/^\/asset\/([^/?]+)$/);
    if (req.method === 'POST' && asset) {
      if (!ASSET_NAME.test(asset[1])) return send(res, 400, { ok: false, error: 'bad asset name' });
      const target = path.join(ASSETS, asset[1]);
      fs.writeFileSync(target, await readBody(req));
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/build') {
      const body = await readBody(req);
      const job = queue.then(() => build(body));
      queue = job.catch(() => {});
      return send(res, 200, await job);
    }

    if (req.method === 'POST' && req.url === '/convert') {
      const body = await readBody(req);
      const job = queue.then(() => convert(body));
      queue = job.catch(() => {});
      return send(res, 200, await job);
    }

    if (req.method === 'POST' && req.url === '/import') {
      const body = await readBody(req);
      const job = queue.then(() => importF2a(body));
      queue = job.catch(() => {});
      return send(res, 200, await job);
    }

    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log(`Error: ${e.message}`);
    send(res, 500, { ok: false, error: e.message });
  }
}

function setReady(message) {
  statusEl.textContent = message;
  statusEl.className = 'on';
}

function attachImport() {
  if (!importEl) return;
  importEl.addEventListener('change', async () => {
    const file = importEl.files && importEl.files[0];
    importEl.value = '';
    if (!file) return;
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      log(`Importing ${file.name}…`);
      const result = await importF2a(buf);
      log(result.ok ? `Imported: ${result.created} objects` : `Error: ${result.error}`);
    } catch (e) {
      log(`Import failed: ${e.message}`);
    }
  });
}

async function adoptExistingServer() {
  const existing = readSessionToken();
  if (!existing) throw new Error(`port ${PORT} is in use`);
  token = existing;
  const res = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/ping' }, resolve);
    req.on('error', reject);
  });
  const body = await readBody(res);
  const data = JSON.parse(body.toString('utf8'));
  if (!data.ok) throw new Error(`port ${PORT} is in use`);
  if (data.token) token = data.token;
  setReady(`Ready — service on localhost:${PORT}`);
  log('Using the Manifest service that started with Illustrator.');
}

function listen() {
  pruneAssets();
  attachImport();
  let pending = 2;
  let bound = 0;

  const tryDone = () => {
    pending--;
    if (pending > 0) return;
    if (bound) {
      ownsServer = true;
      writeSession(token);
      setReady(`Ready — localhost:${PORT}`);
      log('Waiting for Figma…');
      return;
    }
    adoptExistingServer().catch((e) => {
      statusEl.textContent = `Server error: ${e.message}`;
      statusEl.className = '';
    });
  };

  for (const host of ['127.0.0.1', '::1']) {
    const server = http.createServer(handle);
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' || (host === '::1' && e.code === 'EADDRNOTAVAIL')) {
        tryDone();
        return;
      }
      statusEl.textContent = `Server error: ${e.message}`;
      statusEl.className = '';
    });
    server.listen(PORT, host, () => {
      bound++;
      tryDone();
    });
  }
}

listen();
