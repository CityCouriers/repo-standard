'use strict';
// Wspólne narzędzia testów kontroli rozjazdu: wydanie wzorca, atrapa API GitHuba w pamięci, przechwycenie wyjścia.
// Dane wyłącznie syntetyczne.

const fs = require('node:fs');
const params = require('../.github/standard/common/params');
const sync = require('../.github/standard/standard_sync');
const { DriftError } = require('../.github/standard/drift/drift_api');
const h = require('./helpers');

const REPO = 'o/r';
const STD = 'CityCouriers/repo-standard';
const ENDPOINTS = { raw: 'https://raw.test', api: 'https://api.test' };
const NOW = new Date('2026-11-11T10:00:00Z');
const SHA1 = h.fakeSha('release-1');
const SHA2 = h.fakeSha('release-2');
const BASE_SHA = h.fakeSha('base-commit');
const FILE = '.github/standard/x.js';
const OTHER = '.github/standard/y.js';
const GOOD = 'module.exports = 1;\n';

const b64 = (text) => Buffer.from(text).toString('base64');

/** Wydanie z dwoma plikami `exact`; `y.js` jest `overridable`. */
function release(version = 'v1.0.0', files = { [FILE]: GOOD, [OTHER]: 'module.exports = 2;\n' }, extraPaths = []) {
  return h.makeRelease(files, {
    version,
    entries: [{ path: FILE, kind: 'exact', critical: true }, { path: OTHER, kind: 'exact', overridable: true }, ...extraPaths.map((p) => ({ path: p, kind: 'exact', critical: true }))],
  });
}

/** Fałszywa sieć wzorca: manifesty po SHA i tagi (`tags`: tag -> SHA). */
function standardNet(releases) {
  const map = new Map();
  const tags = {};
  for (const [sha, { rel, tag }] of Object.entries(releases)) {
    map.set(sync.rawUrl(ENDPOINTS, STD, sha, 'manifest.json'), Buffer.from(JSON.stringify(rel.manifest)));
    if (tag) tags[tag] = sha;
  }
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (map.has(url)) return map.get(url);
    const tag = /\/git\/ref\/tags\/(v[0-9.]+)$/.exec(url);
    if (tag && tags[tag[1]]) return Buffer.from(JSON.stringify({ object: { type: 'commit', sha: tags[tag[1]] } }));
    throw new sync.SyncError(`brak ${url}`);
  };
  return { fetch, calls };
}

/** Plik parametrów konsumenta jako tekst (z pliku tego repozytorium, z podmienionymi polami). */
function paramsText(patch = {}) {
  const base = JSON.parse(fs.readFileSync(`${h.REPO_ROOT}/.github/repo-standard.json`, 'utf8'));
  return `${JSON.stringify({ ...base, standard: { version: 'v1.0.0', sha: SHA1 }, overrides: [], ...patch }, null, 2)}\n`;
}

/** Drzewo robocze domyślnej gałęzi (zaufane): plik parametrów i pliki wzorca. */
function workspace({ files = { [FILE]: GOOD, [OTHER]: 'module.exports = 2;\n' }, patch } = {}) {
  const root = h.tmpDir('drift-ws-');
  h.writeFile(root, params.PARAMS_PATH, paramsText(patch));
  for (const [rel, text] of Object.entries(files)) h.writeFile(root, rel, text);
  return root;
}

/**
 * Atrapa REST GitHuba w pamięci. `prs`: numer -> { head, base, files: [{filename}], tree: { ścieżka: tekst | {type} } }.
 * `hooks.onGet(path)` i `hooks.onSend(method, path, body)` pozwalają zmieniać stan albo rzucać w trakcie.
 */
function fakeGitHub({ defaultBranch = 'main', prs = {}, issues = [], hooks = {} } = {}) {
  const log = [];
  const statuses = [];
  const state = { prs, issues: issues.map((issue) => ({ ...issue })), nextIssue: 100, baseTip: BASE_SHA };
  const notFound = (path) => new DriftError(`gh api ${path}: HTTP 404`, { notFound: true });
  const route = (path) => {
    log.push(`GET ${path}`);
    if (hooks.onGet) hooks.onGet(path, state);
    let m;
    if (path === `repos/${REPO}`) return { default_branch: defaultBranch };
    if (path === `repos/${REPO}/git/ref/heads/${defaultBranch}`) return { object: { type: 'commit', sha: state.baseTip } };
    if ((m = /^repos\/o\/r\/pulls\/(\d+)$/.exec(path))) {
      const pr = state.prs[m[1]];
      if (!pr) throw notFound(path);
      return { number: Number(m[1]), head: { sha: pr.head }, base: { ref: pr.base || 'main' } };
    }
    if ((m = /^repos\/o\/r\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path))) {
      const pr = Object.values(state.prs).find((candidate) => candidate.head === m[2]);
      const entry = pr ? pr.tree[decodeURIComponent(m[1])] : undefined;
      if (entry === undefined) throw notFound(path);
      if (typeof entry === 'string') return { type: 'file', encoding: 'base64', content: b64(entry), size: Buffer.byteLength(entry) };
      return entry;
    }
    throw new DriftError(`atrapa: nieobsłużona ścieżka ${path}`);
  };
  const api = {
    get: (path) => route(path),
    getAll(path) {
      log.push(`GETALL ${path}`);
      if (hooks.onGet) hooks.onGet(path, state);
      let m;
      if ((m = /^repos\/o\/r\/pulls\/(\d+)\/files\?per_page=100$/.exec(path))) return state.prs[m[1]].files;
      if (/^repos\/o\/r\/pulls\?state=open&base=[a-z]+&per_page=100$/.test(path)) {
        return Object.entries(state.prs).map(([number, pr]) => ({ number: Number(number), head: { sha: pr.head } }));
      }
      if (/^repos\/o\/r\/issues\?state=open&labels=/.test(path)) return state.issues.filter((issue) => issue.state === 'open');
      throw new DriftError(`atrapa: nieobsłużona lista ${path}`);
    },
    send(method, path, body) {
      log.push(`${method} ${path}`);
      if (hooks.onSend) hooks.onSend(method, path, body, state);
      let m;
      if ((m = /^repos\/o\/r\/statuses\/([0-9a-f]{40})$/.exec(path))) {
        statuses.push({ sha: m[1], ...body });
        return {};
      }
      if (path === 'repos/o/r/issues' && method === 'POST') {
        const issue = { number: state.nextIssue += 1, state: 'open', user: { login: 'github-actions[bot]' }, labels: body.labels.map((name) => ({ name })), body: body.body, title: body.title };
        state.issues.push(issue);
        return { number: issue.number };
      }
      if ((m = /^repos\/o\/r\/issues\/(\d+)$/.exec(path)) && method === 'PATCH') {
        const issue = state.issues.find((candidate) => candidate.number === Number(m[1]));
        Object.assign(issue, body);
        return {};
      }
      if ((m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path))) {
        if (method !== 'POST' || typeof body.body !== 'string') throw new DriftError('atrapa: zły komentarz');
        state.issues.find((candidate) => candidate.number === Number(m[1])).comments = [...(state.issues.find((candidate) => candidate.number === Number(m[1])).comments || []), body.body];
        return {};
      }
      throw new DriftError(`atrapa: nieobsłużony zapis ${method} ${path}`);
    },
  };
  return { api, log, statuses, state };
}

/** Odpowiedź API zgłoszenia dla weryfikacji odstępstw: numer -> { state, labels, pull_request }. */
function issueApi(map) {
  return async (url) => {
    const m = /\/issues\/(\d+)$/.exec(url);
    if (!m || !map[m[1]]) throw new Error(`atrapa: brak zgłoszenia ${url}`);
    const entry = map[m[1]];
    return { number: Number(m[1]), state: entry.state || 'open', labels: (entry.labels || ['audit:ok']).map((name) => ({ name })), ...(entry.pull_request ? { pull_request: {} } : {}) };
  };
}

/** Uruchamia `main` kontroli rozjazdu z przechwyceniem wyjścia. */
async function runDrift(argv, { env = {}, deps = {} } = {}) {
  const drift = require('../.github/standard/drift/drift_run');
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await drift.main(argv, { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'test-token', GITHUB_SHA: BASE_SHA, GITHUB_REF_NAME: 'main', ...env }, { endpoints: ENDPOINTS, now: NOW, ...deps });
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

module.exports = {
  REPO, STD, ENDPOINTS, NOW, SHA1, SHA2, BASE_SHA, FILE, OTHER, GOOD,
  release, standardNet, paramsText, workspace, fakeGitHub, issueApi, runDrift, b64,
};
