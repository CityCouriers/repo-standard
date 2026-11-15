'use strict';
// Wspólne narzędzia testów: katalogi tymczasowe, migawki drzewa, lokalny serwer https z certyfikatem
// generowanym na czas testu, uruchamianie `main` z przechwyceniem wyjścia. Dane wyłącznie syntetyczne.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sync = require('../.github/standard/standard_sync');
const params = require('../.github/standard/common/params');

const REPO_ROOT = path.resolve(__dirname, '..');
const sha256 = sync.sha256;

function tmpDir(prefix = 'rs-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(root, relPath, content) {
  const target = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, ...relPath.split('/')), 'utf8');
}

/** Migawka drzewa: ścieżka -> suma (katalogi i dowiązania opisane osobno, dowiązania nie są dereferencjonowane). */
function snapshot(root) {
  const result = {};
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (item.isSymbolicLink()) result[rel] = `link:${fs.readlinkSync(full)}`;
      else if (item.isDirectory()) { result[rel] = 'dir'; walk(full); }
      else result[rel] = sha256(fs.readFileSync(full));
    }
  };
  walk(root);
  return result;
}

/** Tworzy dowiązanie; zwraca false, gdy system na to nie pozwala (np. brak uprawnień na Windows). */
function trySymlink(target, linkPath, kind) {
  try {
    fs.symlinkSync(target, linkPath, kind === 'dir' && process.platform === 'win32' ? 'junction' : kind);
    return true;
  } catch {
    return false;
  }
}

/** Uruchamia `main` z przechwyceniem wyjścia; `env` pusty, żeby nie pisać do podsumowania CI. */
async function run(argv, deps = {}) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await sync.main(argv, {}, deps);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

/** Wydanie syntetyczne: manifest z sumami i treści plików po ścieżce. */
function makeRelease(files, { version = 'v1.0.0', entries } = {}) {
  const list = entries || Object.keys(files).map((p) => ({ path: p, kind: 'exact', critical: true }));
  const manifest = {
    schema: 1,
    version,
    files: [
      ...list.map((entry) => (entry.kind === 'param' ? entry : { ...entry, sha256: entry.sha256 || sha256(Buffer.from(files[entry.source || entry.path])) })),
      { path: params.PARAMS_PATH, kind: 'param' },
    ],
  };
  return { manifest, files };
}

let certCache;
/** Certyfikat testowy dla localhost i 127.0.0.1 (openssl); null, gdy openssl niedostępny. */
function testCert() {
  if (certCache !== undefined) return certCache;
  const dir = tmpDir('rs-cert-');
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  certCache = result.status === 0 ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } : null;
  rmDir(dir);
  return certCache;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * Lokalny serwer wydań. `releases`: { tag: { sha, release, annotated } }. `intercept(req, res)` może przejąć
 * żądanie (np. przekierowanie albo podmianę treści); zwrócenie true oznacza obsłużone. `hits` zapisuje ścieżki.
 */
async function startReleaseServer(releases, { intercept } = {}) {
  const cert = testCert();
  const hits = [];
  const handler = (req, res) => {
    hits.push(req.url);
    if (intercept && intercept(req, res, hits)) return;
    const send = (status, body) => { res.statusCode = status; res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    const refMatch = /^\/api\/repos\/[^/]+\/[^/]+\/git\/ref\/tags\/(v[0-9.]+)$/.exec(req.url);
    if (refMatch) {
      const entry = releases[refMatch[1]];
      if (!entry) return send(404, '{}');
      return send(200, { object: entry.annotated ? { type: 'tag', sha: entry.annotated } : { type: 'commit', sha: entry.sha } });
    }
    const tagMatch = /^\/api\/repos\/[^/]+\/[^/]+\/git\/tags\/([0-9a-f]{40})$/.exec(req.url);
    if (tagMatch) {
      const entry = Object.values(releases).find((candidate) => candidate.annotated === tagMatch[1]);
      return entry ? send(200, { object: { type: 'commit', sha: entry.sha } }) : send(404, '{}');
    }
    const rawMatch = /^\/raw\/[^/]+\/[^/]+\/([0-9a-f]{40})\/(.+)$/.exec(req.url);
    if (rawMatch) {
      const entry = Object.values(releases).find((candidate) => candidate.sha === rawMatch[1]);
      if (!entry) return send(404, 'brak');
      const relPath = decodeURIComponent(rawMatch[2]);
      if (relPath === 'manifest.json') return send(200, JSON.stringify(entry.release.manifest, null, 2));
      return relPath in entry.release.files ? send(200, entry.release.files[relPath]) : send(404, 'brak');
    }
    return send(404, 'brak');
  };
  const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
  const port = await listen(server);
  return {
    port,
    hits,
    cert: cert.cert,
    endpoints: { raw: `https://localhost:${port}/raw`, api: `https://localhost:${port}/api` },
    fetch: sync.makeHttpGet({ ca: cert.cert }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** Zwykły serwer http, który tylko liczy żądania (dowód, że klient nie wyszedł po http). */
async function startPlainServer() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.end('x'); });
  const port = await listen(server);
  return { port, hits, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const fakeSha = (seed) => crypto.createHash('sha1').update(seed).digest('hex');

module.exports = {
  REPO_ROOT, sha256, tmpDir, rmDir, writeFile, readText, snapshot, trySymlink, run, makeRelease,
  testCert, startReleaseServer, startPlainServer, fakeSha,
};
