#!/usr/bin/env node
'use strict';
// Kopiowanie wzorca i kontrola rozjazdu (`check`, `check --self`, `apply`). Node.js, CommonJS, tylko biblioteka standardowa.
//
// `apply` zamienia tag wydania na pełny SHA commita, pobiera `manifest.json` i WSZYSTKIE pliki po tym SHA
// (https, bez tokenu, przekierowania tylko na ten sam host i https), weryfikuje w pamięci sumy SHA-256,
// ścieżki, schemat manifestu i zgodność wersji z tagiem, a dopiero potem zapisuje pliki i na końcu plik
// parametrów. Błąd na etapie pobrania albo weryfikacji to zero zmian w repozytorium.
// `check` porównuje pliki konsumenta z manifestem wersji z pliku parametrów:
//   exact - suma SHA-256 pliku musi się zgadzać;
//   block - zgodny musi być blok tekstu między znacznikami `# repo-standard:begin <id>` i `# repo-standard:end <id>`;
//   seed  - plik kopiowany raz; sprawdzane są tylko wymagane znaczniki;
//   param - plik lokalny walidowany schematem (`common/params.js`).
// Plik z flagą `critical` jest zawsze `exact` i nie może mieć odstępstwa. Odstępstwo (`overrides`) dotyczy tylko
// plików `overridable`; B1 sprawdza jego składnię, ale NIE stan zgłoszenia, więc odstępstwo nie jest uznawane
// (kontrola pliku nie jest pomijana).
//
// Kody wyjścia: 0 zgodne, 1 rozjazd, 2 błąd działania (sieć, zły manifest, zły plik parametrów, odmowa zapisu) - fail-closed.
//
// Użycie:
//   node standard_sync.js check [--root .]
//   node standard_sync.js check --self [--root .]
//   node standard_sync.js apply --version v1.0.0 [--sha <pełny SHA>] [--root .] [--dry-run]

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { parseArgs } = require('node:util');
const params = require('./common/params');

const STANDARD_REPO = 'CityCouriers/repo-standard';
const MANIFEST_PATH = 'manifest.json';
const MANIFEST_SCHEMA = 1;
const MAX_DOWNLOAD = 5000000;
const MAX_REDIRECTS = 5;
const KINDS = ['exact', 'block', 'seed', 'param'];
const ENTRY_KEYS = ['path', 'source', 'kind', 'critical', 'overridable', 'sha256', 'block', 'markers', 'skeleton'];
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCK_ID = /^[a-z0-9-]+$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BEGIN_MARK = '# repo-standard:begin ';
const END_MARK = '# repo-standard:end ';
const SELF_ROOTS = ['.github/standard/', 'scripts/ci/'];
const DEFAULT_ENDPOINTS = { raw: 'https://raw.githubusercontent.com', api: 'https://api.github.com' };

/** Błąd działania (nie rozjazd): sieć, manifest, plik parametrów, odmowa zapisu. */
class SyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncError';
  }
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const dumpJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const isObject = params.isObject;

function textOf(data) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** Tekst UTF-8 albo SyncError z nazwą źródła (zamiast cichej podmiany na pusty napis). */
function requireText(data, what) {
  const text = textOf(data);
  if (text === null) throw new SyncError(`${what}: nie jest poprawnym UTF-8`);
  return text;
}

// ---------------------------------------------------------------- bloki

/** Tekst między znacznikami bloku (każdy wiersz z `\n`); null, gdy znaczników nie ma dokładnie po jednym. */
function blockOf(text, blockId) {
  const lines = text.split('\n');
  const begin = lines.flatMap((line, i) => (line.trim() === BEGIN_MARK + blockId ? [i] : []));
  const end = lines.flatMap((line, i) => (line.trim() === END_MARK + blockId ? [i] : []));
  if (begin.length !== 1 || end.length !== 1 || begin[0] >= end[0]) return null;
  return lines.slice(begin[0] + 1, end[0]).map((line) => `${line}\n`).join('');
}

/** `text` z podmienionym blokiem; null, gdy brak poprawnych znaczników. */
function replaceBlock(text, blockId, newBlock) {
  if (blockOf(text, blockId) === null) return null;
  const lines = text.split('\n');
  const begin = lines.findIndex((line) => line.trim() === BEGIN_MARK + blockId);
  const end = lines.findIndex((line) => line.trim() === END_MARK + blockId);
  return `${lines.slice(0, begin + 1).join('\n')}\n${newBlock}${lines.slice(end).join('\n')}`;
}

// ---------------------------------------------------------------- manifest

/** Ścieżka względna bez segmentu `.git` (także w wariantach wielkości liter i krótkich nazw NTFS). */
function safeManifestPath(value) {
  if (!params.safeRelative(value)) return false;
  return !value.split('/').some((part) => /^\.git$/i.test(part) || /^git~[0-9]+$/i.test(part));
}

function entryErrors(index, entry) {
  const where = `files[${index}]`;
  if (!isObject(entry)) return [`${where}: oczekiwano obiektu`];
  const errors = Object.keys(entry).filter((key) => !ENTRY_KEYS.includes(key)).map((key) => `${where}: nieznany klucz '${key}'`);
  const { path: entryPath, kind } = entry;
  if (!safeManifestPath(entryPath)) errors.push(`${where}.path: oczekiwano bezpiecznej ścieżki względnej`);
  if ('source' in entry && !safeManifestPath(entry.source)) errors.push(`${where}.source: oczekiwano bezpiecznej ścieżki względnej`);
  if (!KINDS.includes(kind)) return [...errors, `${where}.kind: oczekiwano jednego z ${KINDS.join(', ')}`];
  for (const flag of ['critical', 'overridable']) {
    if (flag in entry && typeof entry[flag] !== 'boolean') errors.push(`${where}.${flag}: oczekiwano true/false`);
  }
  if (kind === 'param') {
    if (entryPath !== params.PARAMS_PATH) errors.push(`${where}: plik param to ${params.PARAMS_PATH}`);
    for (const key of ['sha256', 'block', 'markers', 'skeleton']) {
      if (key in entry) errors.push(`${where}: pole '${key}' nie dotyczy rodzaju param`);
    }
    return errors;
  }
  if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) errors.push(`${where}.sha256: oczekiwano 64 znaków hex`);
  if (kind === 'block') {
    if (typeof entry.block !== 'string' || !BLOCK_ID.test(entry.block)) errors.push(`${where}.block: oczekiwano identyfikatora [a-z0-9-]+`);
    if ('skeleton' in entry && typeof entry.skeleton !== 'string') errors.push(`${where}.skeleton: oczekiwano napisu`);
  } else if ('block' in entry || 'skeleton' in entry) {
    errors.push(`${where}: pola block i skeleton dotyczą tylko rodzaju block`);
  }
  if (kind === 'seed') {
    if (!params.isStringList(entry.markers) || entry.markers.length === 0) errors.push(`${where}.markers: oczekiwano niepustej listy napisów`);
  } else if ('markers' in entry) {
    errors.push(`${where}.markers: dotyczy tylko rodzaju seed`);
  }
  if (entry.critical && (kind !== 'exact' || entry.overridable)) errors.push(`${where}: plik krytyczny musi być exact i bez odstępstwa`);
  return errors;
}

function manifestErrors(manifest) {
  if (!isObject(manifest)) return ['manifest: oczekiwano obiektu'];
  const errors = Object.keys(manifest).filter((key) => !['schema', 'version', 'files'].includes(key)).map((key) => `manifest: nieznany klucz '${key}'`);
  if (manifest.schema !== MANIFEST_SCHEMA) errors.push(`manifest.schema: oczekiwano ${MANIFEST_SCHEMA}`);
  if (params.parseVersion(manifest.version) === null) errors.push('manifest.version: oczekiwano postaci v1.2.3');
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) return [...errors, 'manifest.files: oczekiwano niepustej listy'];
  files.forEach((entry, index) => errors.push(...entryErrors(index, entry)));
  const paths = files.filter(isObject).map((entry) => entry.path).filter((p) => typeof p === 'string');
  const repeated = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))].sort();
  errors.push(...repeated.map((p) => `manifest: powtórzona ścieżka ${JSON.stringify(p)}`));
  return errors;
}

function parseManifest(text) {
  let manifest;
  try {
    manifest = params.parseJsonObject(text);
  } catch (error) {
    throw new SyncError(`manifest nie jest poprawnym JSON: ${error.message}`);
  }
  const errors = manifestErrors(manifest);
  if (errors.length) throw new SyncError(`manifest niepoprawny: ${errors.join('; ')}`);
  return manifest;
}

// ---------------------------------------------------------------- pliki lokalne

/** Zawartość zwykłego pliku (bez dowiązania) albo null. */
function readPlainFile(root, relPath) {
  const target = path.join(root, ...relPath.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return null;
  }
  return stat.isFile() && !stat.isSymbolicLink() ? fs.readFileSync(target) : null;
}

/** Rozjazd jednego pliku manifestu względem jego treści (null = brak pliku). */
function entryFinding(entry, data) {
  const { path: entryPath, kind } = entry;
  if (data === null) return [`${entryPath}: brak pliku`];
  if (kind === 'exact') return sha256(data) === entry.sha256 ? [] : [`${entryPath}: rozjazd, suma SHA-256 różni się od manifestu`];
  const text = textOf(data);
  if (text === null) return [`${entryPath}: plik nie jest poprawnym UTF-8`];
  if (kind === 'block') {
    const block = blockOf(text, entry.block);
    if (block === null) return [`${entryPath}: brak znaczników bloku '${entry.block}' (po jednym begin i end)`];
    return sha256(Buffer.from(block)) === entry.sha256 ? [] : [`${entryPath}: rozjazd bloku '${entry.block}'`];
  }
  return entry.markers.filter((marker) => !text.includes(marker)).map((marker) => `${entryPath}: brak znacznika '${marker}'`);
}

function listFiles(base) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(base, item.name);
    return item.isDirectory() ? listFiles(full) : [full];
  });
}

/** Plik parametrów konsumenta jako obiekt; zły UTF-8, JSON albo schemat to SyncError (kod 2). */
function loadConsumerParams(data) {
  const text = requireText(data, params.PARAMS_PATH);
  try {
    return params.load(text);
  } catch (error) {
    if (error instanceof params.ParamsError) throw new SyncError(`plik parametrów niepoprawny: ${error.message}`);
    throw error;
  }
}

/** Odstępstwa z lokalnego pliku parametrów względem manifestu: { findings, notes }. */
function localOverrides(manifest, paramsText, todayMs) {
  let loaded;
  try {
    loaded = params.load(paramsText);
  } catch (error) {
    if (error instanceof params.ParamsError) return { findings: [`${params.PARAMS_PATH}: ${error.message}`], notes: [] };
    throw error;
  }
  const { errors, notes } = params.overrideFindings(manifest, loaded.overrides, todayMs);
  return { findings: errors, notes, params: loaded };
}

function checkSelf(manifest, root, todayMs) {
  const findings = [];
  const listed = new Set();
  for (const entry of manifest.files) {
    listed.add(entry.path);
    if (entry.kind === 'param') continue;
    const origin = entry.source || entry.path;
    const data = readPlainFile(root, origin);
    findings.push(...entryFinding({ ...entry, path: origin }, data));
    if (entry.kind === 'seed' && data !== null && sha256(data) !== entry.sha256) {
      findings.push(`${origin}: rozjazd, suma SHA-256 źródła szablonu różni się od manifestu`);
    }
  }
  for (const prefix of SELF_ROOTS) {
    for (const found of listFiles(path.join(root, ...prefix.split('/')))) {
      const relative = path.relative(root, found).split(path.sep).join('/');
      if (!listed.has(relative)) findings.push(`${relative}: plik wzorca nie jest wpisany do manifestu`);
    }
  }
  let notes = [];
  const paramsData = readPlainFile(root, params.PARAMS_PATH);
  if (paramsData !== null) {
    const text = textOf(paramsData);
    const result = text === null ? { findings: [`${params.PARAMS_PATH}: plik nie jest poprawnym UTF-8`], notes: [] } : localOverrides(manifest, text, todayMs);
    findings.push(...result.findings);
    notes = result.notes;
  }
  return { findings, notes };
}

function checkConsumer(manifest, root, consumerParams, todayMs) {
  const { errors, notes } = params.overrideFindings(manifest, consumerParams.overrides, todayMs);
  const findings = [...errors];
  for (const entry of manifest.files) {
    if (entry.kind === 'param') {
      if (readPlainFile(root, entry.path) === null) findings.push(`${entry.path}: brak pliku parametrów`);
      continue;
    }
    findings.push(...entryFinding(entry, readPlainFile(root, entry.path)));
  }
  return { findings, notes };
}

// ---------------------------------------------------------------- sieć

/**
 * Klient https: tylko `https:`, bez tokenu, przekierowania tylko na ten sam host (z portem) i https.
 * `ca` służy wyłącznie testom z lokalnym certyfikatem; nie ma żadnej opcji dopuszczającej http.
 */
function makeHttpGet({ ca, timeoutMs = 30000 } = {}) {
  const get = (url, origin, redirects) => new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new SyncError(`zły adres: ${url}`));
    }
    if (parsed.protocol !== 'https:') return reject(new SyncError(`tylko https: ${url}`));
    if (origin !== undefined && parsed.host !== origin) return reject(new SyncError(`przekierowanie poza ten sam host: ${url}`));
    const fail = (error) => reject(error instanceof SyncError ? error : new SyncError(`pobranie ${url}: ${error.message}`));
    const request = https.request(parsed, {
      ca,
      headers: { 'User-Agent': 'repo-standard-sync', Accept: '*/*' },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new SyncError(`za dużo przekierowań: ${url}`));
        const location = response.headers.location;
        if (!location) return reject(new SyncError(`przekierowanie bez adresu: ${url}`));
        return get(new URL(location, parsed).href, origin ?? parsed.host, redirects + 1).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new SyncError(`pobranie ${url}: status ${status}`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD) {
          request.destroy(new SyncError(`odpowiedź za duża: ${url}`));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', fail);
    });
    request.on('timeout', () => request.destroy(new SyncError(`przekroczono czas: ${url}`)));
    request.on('error', fail);
    request.end();
  });
  return (url) => get(url, undefined, 0);
}

const encodePath = (relPath) => relPath.split('/').map(encodeURIComponent).join('/');

function rawUrl(endpoints, repo, sha, relPath) {
  if (!REPO_NAME.test(repo) || !params.FULL_SHA.test(sha)) throw new SyncError('zły adres: oczekiwano repo wlasciciel/nazwa i pełnego SHA');
  return `${endpoints.raw}/${repo}/${sha}/${encodePath(relPath)}`;
}

async function fetchManifest(endpoints, repo, sha, fetch) {
  return parseManifest(requireText(await fetch(rawUrl(endpoints, repo, sha, MANIFEST_PATH)), MANIFEST_PATH));
}

function parseApiObject(data, what) {
  const text = requireText(data, `odpowiedź API (${what})`);
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) throw new Error('nie jest obiektem');
    return value;
  } catch (error) {
    throw new SyncError(`odpowiedź API (${what}) niepoprawna: ${error.message}`);
  }
}

/** Pełny SHA commita wskazywanego przez tag wydania (także tag opisany). */
async function resolveTag(endpoints, repo, tag, fetch) {
  if (!REPO_NAME.test(repo) || params.parseVersion(tag) === null) throw new SyncError(`zła nazwa repozytorium albo wersji: ${repo} ${tag}`);
  const reference = parseApiObject(await fetch(`${endpoints.api}/repos/${repo}/git/ref/tags/${tag}`), 'ref');
  let target = reference.object;
  if (isObject(target) && target.type === 'tag' && typeof target.sha === 'string' && params.FULL_SHA.test(target.sha)) {
    target = parseApiObject(await fetch(`${endpoints.api}/repos/${repo}/git/tags/${target.sha}`), 'tag').object;
  }
  if (!isObject(target) || target.type !== 'commit' || typeof target.sha !== 'string' || !params.FULL_SHA.test(target.sha)) {
    throw new SyncError(`tag ${tag} nie wskazuje commita`);
  }
  return target.sha;
}

// ---------------------------------------------------------------- bezpieczne zapisy

/** Odmowa ścieżki spoza repozytorium, w `.git` albo niebezpiecznej (dotyczy KAŻDEGO zapisu, także pliku parametrów). */
function assertSafeTarget(relPath) {
  if (!safeManifestPath(relPath)) throw new SyncError(`${relPath}: niedozwolona ścieżka zapisu (poza repozytorium albo w .git)`);
}

/** Żaden istniejący element ścieżki (plik docelowy ani katalog nadrzędny) nie może być dowiązaniem symbolicznym. */
function assertPlainPath(realRoot, relPath) {
  assertSafeTarget(relPath);
  const parts = relPath.split('/');
  let current = realRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new SyncError(`${relPath}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) throw new SyncError(`${relPath}: ścieżka przechodzi przez dowiązanie symboliczne`);
    const last = index === parts.length - 1;
    if (last ? stat.isDirectory() : !stat.isDirectory()) {
      throw new SyncError(`${relPath}: koliduje z istniejącym ${last ? 'katalogiem' : 'plikiem'}`);
    }
  }
}

/**
 * Zapis przez plik tymczasowy w tym samym katalogu i rename, z ponowną kontrolą bezpośrednio przed rename.
 * Plik tymczasowy jest otwierany z O_CREAT|O_EXCL (otwarcie nie podąża za dowiązaniem pod tą nazwą), a rename
 * podmienia sam wpis katalogu, więc dowiązanie podstawione w miejsce pliku docelowego nie jest dereferencjonowane.
 */
function writeAtomic(realRoot, relPath, content, hooks, phase, created) {
  assertPlainPath(realRoot, relPath);
  const parts = relPath.split('/');
  const target = path.join(realRoot, ...parts);
  const dir = path.dirname(target);
  mkdirTracked(dir, created);
  if (hooks && hooks.afterMkdir) hooks.afterMkdir(relPath, phase);
  assertPlainPath(realRoot, relPath);
  const temp = path.join(dir, `.${parts[parts.length - 1]}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const fd = fs.openSync(temp, flags, 0o644);
  try {
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (hooks && hooks.afterCheck) hooks.afterCheck(relPath, phase);
    assertPlainPath(realRoot, relPath);
    if (fs.realpathSync(dir) !== path.join(realRoot, ...parts.slice(0, -1))) throw new SyncError(`${relPath}: katalog docelowy zmienił się w trakcie zapisu`);
    if (hooks && hooks.beforeRename) hooks.beforeRename(relPath, phase);
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch { /* plik tymczasowy mógł zniknąć razem z podmienionym katalogiem */ }
    throw error;
  }
}

/** mkdir -p, który (gdy podano `created`) zapamiętuje utworzone katalogi od zewnętrznego, żeby sprzątnąć je po awarii. */
function mkdirTracked(dir, created) {
  const missing = [];
  for (let current = dir; !fs.existsSync(current); current = path.dirname(current)) missing.unshift(current);
  fs.mkdirSync(dir, { recursive: true });
  if (created !== undefined) created.push(...missing);
}

function removeCreatedDirs(created) {
  for (const dir of [...created].reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch { /* niepusty albo już usunięty: zostaje */ }
  }
}

function removeFile(realRoot, relPath) {
  assertPlainPath(realRoot, relPath);
  fs.unlinkSync(path.join(realRoot, ...relPath.split('/')));
}

/**
 * Zapisuje pliki po kolei. Przy błędzie w trakcie przywraca poprzednią treść już zapisanych plików (w odwrotnej
 * kolejności) i zgłasza wynik jawnie: co zapisano, co przywrócono, czego przywrócić się nie udało.
 */
function applyWrites(realRoot, writes, hooks) {
  const previous = new Map(writes.map((write) => [write.path, readPlainFile(realRoot, write.path)]));
  const applied = [];
  const created = [];
  for (const write of writes) {
    try {
      writeAtomic(realRoot, write.path, write.content, hooks, 'write', created);
      applied.push(write.path);
    } catch (error) {
      if (applied.length === 0) {
        removeCreatedDirs(created);
        throw new SyncError(`awaria zapisu ${write.path} (nic nie zmieniono): ${error.message}`);
      }
      const restored = [];
      const failed = [];
      for (const done of [...applied].reverse()) {
        try {
          const before = previous.get(done);
          if (before === null) removeFile(realRoot, done);
          else writeAtomic(realRoot, done, before, hooks, 'rollback');
          restored.push(done);
        } catch (restoreError) {
          failed.push(`${done} (${restoreError.message})`);
        }
      }
      const lines = [
        `częściowa awaria zapisu przy ${write.path}: ${error.message}`,
        `zapisano przed awarią: ${applied.join(', ')}`,
        `przywrócono: ${restored.length ? restored.join(', ') : 'nic'}`,
      ];
      if (failed.length === 0) removeCreatedDirs(created);
      if (failed.length) lines.push(`NIE przywrócono (napraw ręcznie, np. git checkout): ${failed.join('; ')}`);
      throw new SyncError(lines.join('\n'));
    }
  }
  return applied;
}

// ---------------------------------------------------------------- apply

function defaultParams() {
  return {
    schema: params.SCHEMA,
    standard: {},
    audit: { active_since: '' },
    triage: { active_since: '' },
    quality_gate: { workflow: 'quality.yml', jobs: ['tests'], required: Object.fromEntries(params.EVENTS.map((event) => [event, ['tests']])) },
    review_gate: { protected_paths: [] },
    overrides: [],
  };
}

/** Pliki do zapisu; wszystko pobrane i zweryfikowane w pamięci przed jakimkolwiek zapisem. */
async function planApply(manifest, root, endpoints, repo, sha, fetch) {
  const writes = [];
  const notes = [];
  for (const entry of manifest.files) {
    if (entry.kind === 'param') continue;
    const data = await fetch(rawUrl(endpoints, repo, sha, entry.source || entry.path));
    const existing = readPlainFile(root, entry.path);
    if (entry.kind === 'block') {
      const text = textOf(data);
      const block = text === null ? null : blockOf(text, entry.block);
      if (block === null || sha256(Buffer.from(block)) !== entry.sha256) {
        throw new SyncError(`${entry.path}: blok '${entry.block}' ze źródła nie zgadza się z manifestem`);
      }
      let content;
      if (existing === null) {
        content = `${entry.skeleton || ''}${BEGIN_MARK}${entry.block}\n${block}${END_MARK}${entry.block}\n`;
      } else {
        const current = textOf(existing);
        const merged = current === null ? null : replaceBlock(current, entry.block, block);
        if (merged === null) throw new SyncError(`${entry.path}: istnieje bez znaczników bloku '${entry.block}'; dopisz znaczniki ręcznie i powtórz`);
        content = merged;
      }
      writes.push({ path: entry.path, content: Buffer.from(content) });
      continue;
    }
    if (sha256(data) !== entry.sha256) throw new SyncError(`${entry.path}: pobrana treść nie zgadza się z sumą w manifeście`);
    if (entry.kind === 'seed' && existing !== null) {
      notes.push(`${entry.path}: seed już istnieje, zostawiony`);
      continue;
    }
    writes.push({ path: entry.path, content: data });
  }
  return { writes, notes };
}

async function runApply(args, env, deps) {
  if (!args.version) throw new SyncError('apply wymaga --version vX.Y.Z');
  if (args.sha !== undefined && !params.FULL_SHA.test(args.sha)) throw new SyncError('--sha: oczekiwano pełnego SHA (40 znaków hex, małe litery)');
  const root = fs.realpathSync(path.resolve(args.root ?? process.cwd()));
  const repo = STANDARD_REPO;
  const sha = await resolveTag(deps.endpoints, repo, args.version, deps.fetch);
  if (args.sha !== undefined && args.sha !== sha) throw new SyncError(`tag ${args.version} wskazuje ${sha}, a podano --sha ${args.sha}`);
  const manifest = await fetchManifest(deps.endpoints, repo, sha, deps.fetch);
  if (manifest.version !== args.version) throw new SyncError(`tag ${args.version} wskazuje manifest wersji ${manifest.version}`);

  assertPlainPath(root, params.PARAMS_PATH);
  const paramsData = readPlainFile(root, params.PARAMS_PATH);
  const paramsValue = paramsData === null ? defaultParams() : loadConsumerParams(paramsData);
  const { errors, notes: overrideNotes } = params.overrideFindings(manifest, paramsValue.overrides, deps.todayMs);
  if (errors.length) throw new SyncError(`odstępstwa w pliku parametrów niepoprawne: ${errors.join('; ')}`);

  const { writes, notes } = await planApply(manifest, root, deps.endpoints, repo, sha, deps.fetch);
  paramsValue.standard = { version: manifest.version, sha };
  writes.push({ path: params.PARAMS_PATH, content: dumpJson(paramsValue) });
  for (const write of writes) assertPlainPath(root, write.path);

  const lines = [...overrideNotes.map((note) => `${note}; plik nadpisany zgodnie z manifestem`), ...notes];
  if (!args['dry-run']) applyWrites(root, writes, deps.hooks);
  lines.unshift(...writes.map((write) => `${write.path}: ${args['dry-run'] ? 'do zapisu' : 'zapisany'}`));
  lines.push(`${params.PARAMS_PATH}: standard ${manifest.version} ${sha}`);
  report(`standard_sync apply ${manifest.version}${args['dry-run'] ? ' (dry-run)' : ''}`, lines, env);
  return 0;
}

// ---------------------------------------------------------------- check

async function runCheck(args, env, deps) {
  const root = fs.realpathSync(path.resolve(args.root ?? process.cwd()));
  if (args.self) {
    const manifestData = readPlainFile(root, MANIFEST_PATH);
    if (manifestData === null) throw new SyncError(`brak ${MANIFEST_PATH}`);
    const manifest = parseManifest(requireText(manifestData, MANIFEST_PATH));
    const { findings, notes } = checkSelf(manifest, root, deps.todayMs);
    report(`standard_sync check --self: ${findings.length ? 'rozjazd' : 'zgodne'}`,
      [...findings, ...notes, ...(findings.length ? [] : [`${manifest.files.length} plików manifestu ${manifest.version}`])], env);
    return findings.length ? 1 : 0;
  }
  const paramsData = readPlainFile(root, params.PARAMS_PATH);
  if (paramsData === null) throw new SyncError(`brak pliku parametrów ${params.PARAMS_PATH}`);
  const consumerParams = loadConsumerParams(paramsData);
  const pin = consumerParams.standard;
  const manifest = await fetchManifest(deps.endpoints, STANDARD_REPO, pin.sha, deps.fetch);
  const findings = [];
  if (manifest.version !== pin.version) findings.push(`manifest po SHA ${pin.sha.slice(0, 12)} to ${manifest.version}, a plik parametrów mówi ${pin.version}`);
  const result = checkConsumer(manifest, root, consumerParams, deps.todayMs);
  findings.push(...result.findings);
  report(`standard_sync check (${pin.version}): ${findings.length ? 'rozjazd' : 'zgodne'}`,
    [...findings, ...result.notes, ...(findings.length ? [] : ['pliki zgodne z manifestem'])], env);
  return findings.length ? 1 : 0;
}

function report(title, lines, env) {
  console.log(`## ${title}`);
  for (const line of lines) console.log(`- ${line}`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## ${title}\n\n${lines.map((line) => `- ${line}\n`).join('')}\n`);
    } catch (error) {
      console.error(`::warning::nie zapisano podsumowania: ${error.message}`);
    }
  }
}

function todayUtcMs(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

const OPTIONS = {
  root: { type: 'string' },
  self: { type: 'boolean', default: false },
  version: { type: 'string' },
  sha: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
};

/** Punkt wejścia (też dla testów): `deps` = { fetch, endpoints, now, hooks }. Zwraca kod wyjścia. */
async function main(argv, env = process.env, deps = {}) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const command = positionals[0];
    if (positionals.length !== 1 || !['check', 'apply'].includes(command)) throw new SyncError('użycie: standard_sync.js check [--self] | apply --version vX.Y.Z');
    if (command === 'apply' && values.self) throw new SyncError('--self dotyczy tylko check');
    if (command === 'check' && (values.version !== undefined || values.sha !== undefined || values['dry-run'])) throw new SyncError('--version, --sha i --dry-run dotyczą tylko apply');
    const full = {
      fetch: deps.fetch || makeHttpGet(),
      endpoints: deps.endpoints || DEFAULT_ENDPOINTS,
      todayMs: todayUtcMs(deps.now || new Date()),
      hooks: deps.hooks,
    };
    return await (command === 'check' ? runCheck : runApply)(values, env, full);
  } catch (error) {
    report('standard_sync: przerwano', `${error.name}: ${error.message}`.split('\n'), env);
    return 2;
  }
}

module.exports = {
  STANDARD_REPO, MANIFEST_PATH, DEFAULT_ENDPOINTS, SyncError,
  sha256, dumpJson, textOf, blockOf, replaceBlock, parseManifest, manifestErrors, readPlainFile,
  checkSelf, checkConsumer, makeHttpGet, rawUrl, resolveTag, assertPlainPath, writeAtomic, applyWrites, main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
