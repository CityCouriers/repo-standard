'use strict';
// Testy `main` (check, check --self, apply), raportu i klienta https z dokładnymi komunikatami i wyjściem.
// Sieć symulowana funkcją fetch albo lokalnym serwerem https z certyfikatem testowym. Dane syntetyczne.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const params = require('../.github/standard/common/params');
const sync = require('../.github/standard/standard_sync');
const h = require('./helpers');

const SHA = h.fakeSha('main-tests');
const NOW = new Date('2026-11-11T10:00:00Z');
const REPO = 'CityCouriers/repo-standard';
const ENDPOINTS = { raw: 'https://raw.test', api: 'https://api.test' };
const BEGIN = '# repo-standard:begin ';
const END = '# repo-standard:end ';
const P = params.PARAMS_PATH;
const ISSUE = `o/r${String.fromCharCode(35)}1`;
const SYNC_FILE = path.join(h.REPO_ROOT, '.github', 'standard', 'standard_sync.js');

/** Fałszywa sieć: tag -> SHA, manifest i pliki po SHA. Zapisuje wszystkie adresy. */
function fakeNet(release, { tag = 'v1.0.0', sha = SHA } = {}) {
  const calls = [];
  const map = new Map();
  map.set(`${ENDPOINTS.api}/repos/${REPO}/git/ref/tags/${tag}`, Buffer.from(JSON.stringify({ object: { type: 'commit', sha } })));
  map.set(sync.rawUrl(ENDPOINTS, REPO, sha, 'manifest.json'), Buffer.from(JSON.stringify(release.manifest)));
  for (const [file, content] of Object.entries(release.files)) map.set(sync.rawUrl(ENDPOINTS, REPO, sha, file), Buffer.isBuffer(content) ? content : Buffer.from(content));
  const fetch = async (url) => {
    calls.push(url);
    if (!map.has(url)) throw new sync.SyncError(`brak ${url}`);
    return map.get(url);
  };
  return { fetch, calls, deps: { fetch, endpoints: ENDPOINTS, now: NOW } };
}

/** `main` z przechwyceniem console.log i console.error. */
async function runIO(argv, deps = {}, env = {}) {
  const log = console.log;
  const error = console.error;
  const out = [];
  const err = [];
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    const code = await sync.main(argv, env, deps);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const applyArgs = (root, extra = []) => ['apply', '--version', 'v1.0.0', '--root', root, ...extra];
const checkArgs = (root, extra = []) => ['check', '--root', root, ...extra];
const abort = (message) => `## standard_sync: przerwano\n- SyncError: ${message}`;

function consumerParams({ overrides = [], standard = { version: 'v1.0.0', sha: SHA } } = {}) {
  return {
    schema: 1, standard, audit: { active_since: '' }, triage: { active_since: '' },
    quality_gate: { workflow: 'quality.yml', jobs: ['tests'], required: { pull_request: ['tests'], push: ['tests'], workflow_dispatch: ['tests'] } },
    review_gate: { protected_paths: [] }, overrides,
  };
}

test('stałe i adresy domyślne', () => {
  assert.equal(sync.STANDARD_REPO, 'CityCouriers/repo-standard');
  assert.equal(sync.MANIFEST_PATH, 'manifest.json');
  assert.deepEqual(sync.DEFAULT_ENDPOINTS, { raw: 'https://raw.githubusercontent.com', api: 'https://api.github.com' });
});

// ------------------------------------------------------------------ użycie i flagi

test('main: złe użycie kończy się kodem 2 z komunikatem', async () => {
  const usage = abort('użycie: standard_sync.js check [--self] | apply --version vX.Y.Z');
  for (const argv of [[], ['check', 'apply'], ['inne'], ['check', '--root']]) {
    const result = await runIO(argv);
    assert.equal(result.code, 2, JSON.stringify(argv));
    if (argv.length < 2 || argv[0] !== 'check' || argv[1] !== '--root') assert.equal(result.out, usage, JSON.stringify(argv));
  }
  const unknown = await runIO(['check', '--nieznana']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /^## standard_sync: przerwano\n- TypeError: /);
  const extra = await runIO(['check', 'x', 'y']);
  assert.equal(extra.out, usage);
});

test('main: flagi niedozwolone dla danego polecenia', async () => {
  const self = await runIO(['apply', '--self', '--version', 'v1.0.0']);
  assert.deepEqual([self.code, self.out], [2, abort('--self dotyczy tylko check')]);
  const only = abort('--version, --sha i --dry-run dotyczą tylko apply');
  for (const extra of [['--version', 'v1.0.0'], ['--sha', SHA], ['--dry-run']]) {
    const result = await runIO(['check', ...extra]);
    assert.deepEqual([result.code, result.out], [2, only], extra.join(' '));
  }
  const noVersion = await runIO(['apply']);
  assert.deepEqual([noVersion.code, noVersion.out], [2, abort('apply wymaga --version vX.Y.Z')]);
  const emptyVersion = await runIO(['apply', '--version', '']);
  assert.deepEqual([emptyVersion.code, emptyVersion.out], [2, abort('apply wymaga --version vX.Y.Z')]);
  const badSha = await runIO(['apply', '--version', 'v1.0.0', '--sha', 'abc']);
  assert.deepEqual([badSha.code, badSha.out], [2, abort('--sha: oczekiwano pełnego SHA (40 znaków hex, małe litery)')]);
  const upper = await runIO(['apply', '--version', 'v1.0.0', '--sha', SHA.toUpperCase()]);
  assert.equal(upper.out, abort('--sha: oczekiwano pełnego SHA (40 znaków hex, małe litery)'));
});

// ------------------------------------------------------------------ apply

const FILES = { 'tools/a.js': '// a\n' };

test('apply: dokładne wyjście, domyślne parametry i zapis na końcu', async (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const net = fakeNet(h.makeRelease(FILES));
  const result = await runIO(applyArgs(root), net.deps);
  assert.equal(result.code, 0, result.out);
  assert.equal(result.out, `## standard_sync apply v1.0.0\n- tools/a.js: zapisany\n- ${P}: zapisany\n- ${P}: standard v1.0.0 ${SHA}`);
  assert.equal(h.readText(root, 'tools/a.js'), '// a\n');
  const expected = {
    schema: 1, standard: { version: 'v1.0.0', sha: SHA }, audit: { active_since: '' }, triage: { active_since: '' },
    quality_gate: { workflow: 'quality.yml', jobs: ['tests'], required: { pull_request: ['tests'], push: ['tests'], workflow_dispatch: ['tests'] } },
    review_gate: { protected_paths: [] }, overrides: [],
  };
  assert.equal(h.readText(root, P), `${JSON.stringify(expected, null, 2)}\n`);
  assert.equal(net.calls[0], `${ENDPOINTS.api}/repos/${REPO}/git/ref/tags/v1.0.0`);
});

test('apply --dry-run: wyjście "do zapisu" i zero zmian', async (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const before = h.snapshot(root);
  const result = await runIO(applyArgs(root, ['--dry-run']), fakeNet(h.makeRelease(FILES)).deps);
  assert.equal(result.code, 0);
  assert.equal(result.out, `## standard_sync apply v1.0.0 (dry-run)\n- tools/a.js: do zapisu\n- ${P}: do zapisu\n- ${P}: standard v1.0.0 ${SHA}`);
  assert.deepEqual(h.snapshot(root), before);
});

test('apply: odmowy z dokładnymi komunikatami i bez zmian', async (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const before = h.snapshot(root);
  const other = h.fakeSha('inny');
  const shaMismatch = await runIO(applyArgs(root, ['--sha', other]), fakeNet(h.makeRelease(FILES)).deps);
  assert.deepEqual([shaMismatch.code, shaMismatch.out], [2, abort(`tag v1.0.0 wskazuje ${SHA}, a podano --sha ${other}`)]);
  const sameSha = await runIO(applyArgs(root, ['--sha', SHA, '--dry-run']), fakeNet(h.makeRelease(FILES)).deps);
  assert.equal(sameSha.code, 0, 'zgodny --sha przechodzi');
  const versionMismatch = await runIO(applyArgs(root), fakeNet(h.makeRelease(FILES, { version: 'v1.0.1' })).deps);
  assert.deepEqual([versionMismatch.code, versionMismatch.out], [2, abort('tag v1.0.0 wskazuje manifest wersji v1.0.1')]);
  const tampered = h.makeRelease(FILES);
  tampered.manifest.files[0].sha256 = 'b'.repeat(64);
  const exact = await runIO(applyArgs(root), fakeNet(tampered).deps);
  assert.deepEqual([exact.code, exact.out], [2, abort('tools/a.js: pobrana treść nie zgadza się z sumą w manifeście')]);
  assert.deepEqual(h.snapshot(root), before);
});

test('apply: odstępstwa w pliku parametrów (błędy łączone średnikiem i noty)', async (t) => {
  const open = h.makeRelease({ 'x/open.yml': 'O\n' }, { entries: [{ path: 'x/open.yml', kind: 'exact', overridable: true }] });
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const bad = [
    { path: 'nie/ma.yml', reason: 'r', until: '2026-12-01', issue: ISSUE },
    { path: 'tez/nie.yml', reason: 'r', until: '2026-12-01', issue: ISSUE },
  ];
  h.writeFile(root, P, JSON.stringify(consumerParams({ overrides: bad })));
  const errors = params.overrideFindings(open.manifest, bad, Date.UTC(2026, 10, 11)).errors;
  assert.equal(errors.length, 2);
  const before = h.snapshot(root);
  const rejected = await runIO(applyArgs(root), fakeNet(open).deps);
  assert.deepEqual([rejected.code, rejected.out], [2, abort(`odstępstwa w pliku parametrów niepoprawne: ${errors.join('; ')}`)]);
  assert.deepEqual(h.snapshot(root), before);
  const good = [{ path: 'x/open.yml', reason: 'r', until: '2026-12-01', issue: ISSUE }];
  h.writeFile(root, P, JSON.stringify(consumerParams({ overrides: good, standard: { version: 'v0.9.0', sha: h.fakeSha('stary') } })));
  const accepted = await runIO(applyArgs(root), fakeNet(open).deps);
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(accepted.out, [
    '## standard_sync apply v1.0.0',
    `- x/open.yml: zapisany`,
    `- ${P}: zapisany`,
    `- odstępstwo x/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane; plik nadpisany zgodnie z manifestem`,
    `- ${P}: standard v1.0.0 ${SHA}`,
  ].join('\n'));
  const written = JSON.parse(h.readText(root, P));
  assert.deepEqual(written.standard, { version: 'v1.0.0', sha: SHA });
  assert.deepEqual(written.overrides, good, 'odstępstwa zachowane');
});

test('apply: uszkodzony plik parametrów konsumenta', async (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, P, Buffer.from([0xff]));
  const utf = await runIO(applyArgs(root), fakeNet(h.makeRelease(FILES)).deps);
  assert.deepEqual([utf.code, utf.out], [2, abort(`${P}: nie jest poprawnym UTF-8`)]);
  h.writeFile(root, P, '{');
  const json = await runIO(applyArgs(root), fakeNet(h.makeRelease(FILES)).deps);
  assert.deepEqual([json.code, json.out], [2, abort(`plik parametrów niepoprawny: plik parametrów nie jest poprawnym JSON: oczekiwano klucza (pozycja 1)`)]);
});

const blockRelease = (extra = {}, sourceText = `pre\n${BEGIN}b1\nBLOCK\n${END}b1\npost\n`) => h.makeRelease(
  { 'cfg/block.txt': sourceText },
  { entries: [{ path: 'cfg/block.txt', kind: 'block', block: 'b1', sha256: h.sha256(Buffer.from('BLOCK\n')), ...extra }] },
);

test('apply: pliki block (nowy ze szkieletem i bez, scalenie, odmowy)', async (t) => {
  const run = async (release, setup) => {
    const root = h.tmpDir();
    t.after(() => h.rmDir(root));
    if (setup) setup(root);
    const result = await runIO(applyArgs(root), fakeNet(release).deps);
    return { root, result };
  };
  const withSkeleton = await run(blockRelease({ skeleton: '# szkielet\n' }));
  assert.equal(withSkeleton.result.code, 0, withSkeleton.result.out);
  assert.equal(h.readText(withSkeleton.root, 'cfg/block.txt'), `# szkielet\n${BEGIN}b1\nBLOCK\n${END}b1\n`);
  const bare = await run(blockRelease());
  assert.equal(h.readText(bare.root, 'cfg/block.txt'), `${BEGIN}b1\nBLOCK\n${END}b1\n`);
  const merged = await run(blockRelease(), (root) => h.writeFile(root, 'cfg/block.txt', `top\n${BEGIN}b1\nOLD\n${END}b1\nbottom\n`));
  assert.equal(h.readText(merged.root, 'cfg/block.txt'), `top\n${BEGIN}b1\nBLOCK\n${END}b1\nbottom\n`);
  const noMarkers = `cfg/block.txt: istnieje bez znaczników bloku 'b1'; dopisz znaczniki ręcznie i powtórz`;
  const plain = await run(blockRelease(), (root) => h.writeFile(root, 'cfg/block.txt', 'bez znaczników\n'));
  assert.deepEqual([plain.result.code, plain.result.out], [2, abort(noMarkers)]);
  assert.equal(h.readText(plain.root, 'cfg/block.txt'), 'bez znaczników\n');
  const binary = await run(blockRelease(), (root) => h.writeFile(root, 'cfg/block.txt', Buffer.from([0xff, 0xfe])));
  assert.deepEqual([binary.result.code, binary.result.out], [2, abort(noMarkers)]);
  const mismatch = `cfg/block.txt: blok 'b1' ze źródła nie zgadza się z manifestem`;
  const badSum = await run(blockRelease({ sha256: 'c'.repeat(64) }));
  assert.deepEqual([badSum.result.code, badSum.result.out], [2, abort(mismatch)]);
  const noBlock = await run(blockRelease({}, 'źródło bez znaczników\n'));
  assert.deepEqual([noBlock.result.code, noBlock.result.out], [2, abort(mismatch)]);
  const binarySource = await run(blockRelease({}, Buffer.from([0xff, 0xfe])));
  assert.deepEqual([binarySource.result.code, binarySource.result.out], [2, abort(mismatch)]);
  assert.equal(fs.existsSync(path.join(badSum.root, 'cfg')), false, 'odmowa przed jakimkolwiek zapisem');
});

test('apply: seed zapisany raz i nigdy nadpisany', async (t) => {
  const release = h.makeRelease({ 'cfg/seed.txt': 'SEED M\n' }, { entries: [{ path: 'cfg/seed.txt', kind: 'seed', markers: ['M'] }] });
  const fresh = h.tmpDir();
  const existing = h.tmpDir();
  t.after(() => { h.rmDir(fresh); h.rmDir(existing); });
  const created = await runIO(applyArgs(fresh), fakeNet(release).deps);
  assert.equal(created.out, `## standard_sync apply v1.0.0\n- cfg/seed.txt: zapisany\n- ${P}: zapisany\n- ${P}: standard v1.0.0 ${SHA}`);
  assert.equal(h.readText(fresh, 'cfg/seed.txt'), 'SEED M\n');
  h.writeFile(existing, 'cfg/seed.txt', 'moje\n');
  const kept = await runIO(applyArgs(existing), fakeNet(release).deps);
  assert.equal(kept.out, `## standard_sync apply v1.0.0\n- ${P}: zapisany\n- cfg/seed.txt: seed już istnieje, zostawiony\n- ${P}: standard v1.0.0 ${SHA}`);
  assert.equal(h.readText(existing, 'cfg/seed.txt'), 'moje\n');
});

test('apply: dowiązanie w ścieżkach zapisu jest odrzucane przed pobraniem i przed zapisem', async (t) => {
  const outside = h.tmpDir();
  t.after(() => h.rmDir(outside));
  const first = P.split('/')[0];
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  if (!h.trySymlink(outside, path.join(root, first), 'dir')) return;
  const net = fakeNet(h.makeRelease(FILES));
  const early = await runIO(applyArgs(root), net.deps);
  assert.equal(early.code, 2);
  assert.equal(early.out, abort(`${P}: ścieżka przechodzi przez dowiązanie symboliczne`));
  assert.deepEqual(net.calls.filter((url) => url.includes('/tools/')), [], 'żaden plik nie został pobrany');
  assert.deepEqual(fs.readdirSync(outside), []);
  const root2 = h.tmpDir();
  t.after(() => h.rmDir(root2));
  if (!h.trySymlink(outside, path.join(root2, 'd'), 'dir')) return;
  const late = await runIO(applyArgs(root2), fakeNet(h.makeRelease({ 'd/x.txt': 'x\n' })).deps);
  assert.equal(late.code, 2);
  assert.equal(late.out, abort('d/x.txt: ścieżka przechodzi przez dowiązanie symboliczne'), 'odmowa przed jakimkolwiek zapisem, bez opakowania w awarię zapisu');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('writeAtomic: kontrola ścieżki po utworzeniu katalogów działa przed otwarciem pliku tymczasowego', (t) => {
  const root = h.tmpDir();
  const outside = h.tmpDir();
  t.after(() => { h.rmDir(root); h.rmDir(outside); });
  if (!h.trySymlink(outside, path.join(root, 'probe'), 'dir')) return;
  fs.rmSync(path.join(root, 'probe'));
  const events = [];
  const hooks = {
    afterMkdir: () => {
      fs.rmSync(path.join(root, 'd'), { recursive: true });
      h.trySymlink(outside, path.join(root, 'd'), 'dir');
    },
    afterCheck: () => events.push('afterCheck'),
  };
  assert.throws(() => sync.writeAtomic(root, 'd/x.txt', Buffer.from('x'), hooks, 'write', []), (error) => error.message === 'd/x.txt: ścieżka przechodzi przez dowiązanie symboliczne');
  assert.deepEqual(events, [], 'plik tymczasowy nie został nawet utworzony');
});

// ------------------------------------------------------------------ check konsumenta

const CHECK_FILES = { 'tools/a.js': '// a\n' };

function consumerRoot(t, { params: value = consumerParams(), files = CHECK_FILES } = {}) {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  for (const [file, content] of Object.entries(files)) h.writeFile(root, file, content);
  if (value !== null) h.writeFile(root, P, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return root;
}

test('check: zgodne repozytorium i brak/uszkodzenie pliku parametrów', async (t) => {
  const net = fakeNet(h.makeRelease(CHECK_FILES));
  const ok = await runIO(checkArgs(consumerRoot(t)), net.deps);
  assert.deepEqual([ok.code, ok.out], [0, '## standard_sync check (v1.0.0): zgodne\n- pliki zgodne z manifestem']);
  assert.deepEqual(net.calls, [sync.rawUrl(ENDPOINTS, REPO, SHA, 'manifest.json')], 'tylko manifest po przypiętym SHA');
  const missing = await runIO(checkArgs(consumerRoot(t, { params: null })), net.deps);
  assert.deepEqual([missing.code, missing.out], [2, abort(`brak pliku parametrów ${P}`)]);
  const broken = await runIO(checkArgs(consumerRoot(t, { params: '{' })), net.deps);
  assert.deepEqual([broken.code, broken.out], [2, abort('plik parametrów niepoprawny: plik parametrów nie jest poprawnym JSON: oczekiwano klucza (pozycja 1)')]);
  const binary = await runIO(checkArgs(consumerRoot(t, { params: Buffer.from([0xff]) })), net.deps);
  assert.deepEqual([binary.code, binary.out], [2, abort(`${P}: nie jest poprawnym UTF-8`)]);
});

test('check: błąd inny niż ParamsError przechodzi bez opakowania', async (t) => {
  const root = consumerRoot(t);
  const original = params.load;
  params.load = () => { throw new TypeError('awaria wewnętrzna'); };
  try {
    const result = await runIO(checkArgs(root), fakeNet(h.makeRelease(CHECK_FILES)).deps);
    assert.deepEqual([result.code, result.out], [2, '## standard_sync: przerwano\n- TypeError: awaria wewnętrzna']);
  } finally {
    params.load = original;
  }
});

test('check: rozjazd wersji i pliku, noty po błędach, kod 1', async (t) => {
  const open = h.makeRelease({ 'x/open.yml': 'O\n', 'tools/a.js': '// a\n' }, { version: 'v1.0.1', entries: [{ path: 'x/open.yml', kind: 'exact', overridable: true }, { path: 'tools/a.js', kind: 'exact' }] });
  const overrides = [{ path: 'x/open.yml', reason: 'r', until: '2026-12-01', issue: ISSUE }];
  const root = consumerRoot(t, { params: consumerParams({ overrides }), files: { 'x/open.yml': 'O\n', 'tools/a.js': '// ZMIANA\n' } });
  const result = await runIO(checkArgs(root), fakeNet(open).deps);
  assert.equal(result.code, 1);
  assert.equal(result.out, [
    '## standard_sync check (v1.0.0): rozjazd',
    `- manifest po SHA ${SHA.slice(0, 12)} to v1.0.1, a plik parametrów mówi v1.0.0`,
    '- tools/a.js: rozjazd, suma SHA-256 różni się od manifestu',
    `- odstępstwo x/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane`,
  ].join('\n'));
  const fine = await runIO(checkArgs(consumerRoot(t, { params: consumerParams({ overrides }), files: { 'x/open.yml': 'O\n', 'tools/a.js': '// a\n' } })), fakeNet(h.makeRelease({ 'x/open.yml': 'O\n', 'tools/a.js': '// a\n' }, { entries: [{ path: 'x/open.yml', kind: 'exact', overridable: true }, { path: 'tools/a.js', kind: 'exact' }] })).deps);
  assert.deepEqual([fine.code, fine.out], [0, `## standard_sync check (v1.0.0): zgodne\n- odstępstwo x/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane\n- pliki zgodne z manifestem`]);
});

test('check: data z deps.now rozstrzyga o wygaśnięciu odstępstwa', async (t) => {
  const release = h.makeRelease({ 'x/open.yml': 'O\n' }, { entries: [{ path: 'x/open.yml', kind: 'exact', overridable: true }] });
  const overrides = [{ path: 'x/open.yml', reason: 'r', until: '2020-01-15', issue: ISSUE }];
  const root = consumerRoot(t, { params: consumerParams({ overrides }), files: { 'x/open.yml': 'O\n' } });
  const deps = { ...fakeNet(release).deps, now: new Date('2020-01-01T12:00:00Z') };
  const past = await runIO(checkArgs(root), deps);
  assert.equal(past.code, 0, past.out);
  const today = await runIO(checkArgs(root), { ...deps, now: undefined });
  assert.equal(today.code, 1, 'bez deps.now liczy się dzisiejsza data: odstępstwo wygasło');
});

// ------------------------------------------------------------------ check --self i punkt wejścia

function selfRoot(t) {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const release = h.makeRelease({ 'a.txt': 'A\n' });
  h.writeFile(root, 'manifest.json', JSON.stringify(release.manifest));
  h.writeFile(root, 'a.txt', 'A\n');
  return root;
}

test('check --self: zgodne, rozjazd i brak manifestu', async (t) => {
  const root = selfRoot(t);
  const ok = await runIO(['check', '--self', '--root', root]);
  assert.deepEqual([ok.code, ok.out], [0, '## standard_sync check --self: zgodne\n- 2 plików manifestu v1.0.0']);
  h.writeFile(root, 'a.txt', 'ZMIANA\n');
  const drift = await runIO(['check', '--self', '--root', root]);
  assert.deepEqual([drift.code, drift.out], [1, '## standard_sync check --self: rozjazd\n- a.txt: rozjazd, suma SHA-256 różni się od manifestu']);
  fs.rmSync(path.join(root, 'manifest.json'));
  const missing = await runIO(['check', '--self', '--root', root]);
  assert.deepEqual([missing.code, missing.out], [2, abort('brak manifest.json')]);
  h.writeFile(root, 'manifest.json', Buffer.from([0xff]));
  const binary = await runIO(['check', '--self', '--root', root]);
  assert.deepEqual([binary.code, binary.out], [2, abort('manifest.json: nie jest poprawnym UTF-8')]);
});

test('check --self: nota odstępstwa wzorca jest wypisana po błędach', async (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const release = h.makeRelease({ 'a.txt': 'A\n' }, { entries: [{ path: 'a.txt', kind: 'exact', overridable: true }] });
  h.writeFile(root, 'manifest.json', JSON.stringify(release.manifest));
  h.writeFile(root, 'a.txt', 'A\n');
  h.writeFile(root, P, JSON.stringify(consumerParams({ overrides: [{ path: 'a.txt', reason: 'r', until: '2026-12-01', issue: ISSUE }] })));
  const result = await runIO(['check', '--self', '--root', root], { now: NOW });
  assert.deepEqual([result.code, result.out], [0, `## standard_sync check --self: zgodne\n- odstępstwo a.txt: ${params.UNVERIFIED_NOTE}, nie jest uznane\n- 2 plików manifestu v1.0.0`]);
});

test('podsumowanie GITHUB_STEP_SUMMARY: dopisywane, a awaria zapisu to ostrzeżenie', async (t) => {
  const root = selfRoot(t);
  const dir = h.tmpDir();
  t.after(() => h.rmDir(dir));
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(summary, 'wcześniej\n');
  const first = await runIO(['check', '--self', '--root', root], {}, { GITHUB_STEP_SUMMARY: summary });
  assert.equal(first.code, 0);
  assert.equal(first.err, '');
  assert.equal(fs.readFileSync(summary, 'utf8'), 'wcześniej\n## standard_sync check --self: zgodne\n\n- 2 plików manifestu v1.0.0\n\n');
  const second = await runIO(['check', '--self', '--root', root], {}, { GITHUB_STEP_SUMMARY: summary });
  assert.equal(second.code, 0);
  assert.equal(fs.readFileSync(summary, 'utf8').split('## standard_sync check --self').length, 3, 'drugi przebieg dopisany, nie nadpisany');
  const many = path.join(dir, 'many.md');
  h.writeFile(root, 'b.txt', 'B\n');
  const release = h.makeRelease({ 'a.txt': 'A\n', 'b.txt': 'B\n' });
  h.writeFile(root, 'manifest.json', JSON.stringify(release.manifest));
  h.writeFile(root, 'a.txt', 'ZMIANA A\n');
  h.writeFile(root, 'b.txt', 'ZMIANA B\n');
  const drift = await runIO(['check', '--self', '--root', root], {}, { GITHUB_STEP_SUMMARY: many });
  assert.equal(drift.code, 1);
  assert.equal(fs.readFileSync(many, 'utf8'), '## standard_sync check --self: rozjazd\n\n- a.txt: rozjazd, suma SHA-256 różni się od manifestu\n- b.txt: rozjazd, suma SHA-256 różni się od manifestu\n\n');
  h.writeFile(root, 'a.txt', 'A\n');
  h.writeFile(root, 'b.txt', 'B\n');
  h.writeFile(root, 'manifest.json', JSON.stringify(h.makeRelease({ 'a.txt': 'A\n' }).manifest));
  const unwritable = await runIO(['check', '--self', '--root', root], {}, { GITHUB_STEP_SUMMARY: dir });
  assert.equal(unwritable.code, 0, 'awaria podsumowania nie zmienia kodu wyjścia');
  assert.match(unwritable.err, /^::warning::nie zapisano podsumowania: .+/);
  const none = await runIO(['check', '--self', '--root', root], {}, {});
  assert.equal(none.err, '', 'bez GITHUB_STEP_SUMMARY nic nie jest zapisywane');
  const empty = await runIO(['check', '--self', '--root', root], {}, { GITHUB_STEP_SUMMARY: '' });
  assert.equal(empty.err, '');
});

test('uruchomienie jako program: kody wyjścia, argumenty i katalog bieżący jako domyślny root', (t) => {
  const root = selfRoot(t);
  const exec = (args, cwd) => spawnSync(process.execPath, [SYNC_FILE, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  const ok = exec(['check', '--self'], root);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout, '## standard_sync check --self: zgodne\n- 2 plików manifestu v1.0.0\n');
  const viaRoot = exec(['check', '--self', '--root', root], os_tmp());
  assert.equal(viaRoot.status, 0, viaRoot.stdout + viaRoot.stderr);
  h.writeFile(root, 'a.txt', 'ZMIANA\n');
  assert.equal(exec(['check', '--self'], root).status, 1);
  const usage = exec([], root);
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /użycie: standard_sync\.js/);
});

function os_tmp() {
  return require('node:os').tmpdir();
}

// ------------------------------------------------------------------ klient https

const SKIP = h.testCert() ? false : 'brak openssl (testy sieciowe pominięte)';

async function serve(t, handler, options) {
  const cert = h.testCert();
  const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { port, base: `https://localhost:${port}`, fetch: sync.makeHttpGet({ ca: cert.cert, ...options }) };
}

test('klient https: nagłówki, metoda i treść odpowiedzi', { skip: SKIP }, async (t) => {
  const seen = [];
  const server = await serve(t, (req, res) => { seen.push([req.method, req.headers['user-agent'], req.headers.accept]); res.end('treść'); });
  const body = await server.fetch(`${server.base}/x`);
  assert.equal(body.toString('utf8'), 'treść');
  assert.deepEqual(seen, [['GET', 'repo-standard-sync', '*/*']]);
});

test('klient https: błędy adresu, statusu i połączenia', { skip: SKIP }, async (t) => {
  const server = await serve(t, (req, res) => { res.statusCode = 500; res.end('x'); });
  await assert.rejects(server.fetch('to nie jest adres'), (error) => error instanceof sync.SyncError && error.message === 'zły adres: to nie jest adres');
  await assert.rejects(server.fetch(`${server.base}/x`), (error) => error instanceof sync.SyncError && error.message === `pobranie ${server.base}/x: status 500`);
  const closed = await serve(t, () => {});
  const url = `${closed.base}/x`;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dead = https.createServer();
  const port = await new Promise((resolve) => dead.listen(0, '127.0.0.1', () => resolve(dead.address().port)));
  await new Promise((resolve) => dead.close(resolve));
  const deadUrl = `https://localhost:${port}/x`;
  await assert.rejects(closed.fetch(deadUrl), (error) => error instanceof sync.SyncError && error.message.startsWith(`pobranie ${deadUrl}: `));
  assert.ok(url.length > 0);
});

test('klient https: przekierowania (względne, limit, brak adresu, inny host)', { skip: SKIP }, async (t) => {
  const server = await serve(t, (req, res) => {
    const hop = /^\/r\/(\d+)$/.exec(req.url);
    if (req.url === '/bez-adresu') { res.statusCode = 302; return res.end(); }
    if (req.url === '/inny-host') { res.statusCode = 301; res.setHeader('Location', `https://127.0.0.1:${req.socket.localPort}/x`); return res.end(); }
    if (hop && Number(hop[1]) > 0) { res.statusCode = [301, 302, 303, 307, 308][Number(hop[1]) % 5]; res.setHeader('Location', `/r/${Number(hop[1]) - 1}`); return res.end(); }
    res.end('koniec');
  });
  assert.equal((await server.fetch(`${server.base}/r/5`)).toString('utf8'), 'koniec', 'pięć przekierowań jest dozwolone');
  assert.equal((await server.fetch(`${server.base}/r/1`)).toString('utf8'), 'koniec');
  await assert.rejects(server.fetch(`${server.base}/r/6`), (error) => error instanceof sync.SyncError && error.message === `za dużo przekierowań: ${server.base}/r/1`);
  await assert.rejects(server.fetch(`${server.base}/bez-adresu`), (error) => error.message === `przekierowanie bez adresu: ${server.base}/bez-adresu`);
  await assert.rejects(server.fetch(`${server.base}/inny-host`), (error) => error.message === `przekierowanie poza ten sam host: https://127.0.0.1:${server.port}/x`);
});

test('klient https: przerwana odpowiedź to SyncError z nazwą adresu, a nie przekroczenie czasu', { skip: SKIP }, async (t) => {
  const server = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': '100' });
    res.write('abc');
    setTimeout(() => req.socket.destroy(), 20);
  }, { timeoutMs: 5000 });
  const url = `${server.base}/x`;
  await assert.rejects(server.fetch(url), (error) => error instanceof sync.SyncError && error.message.startsWith(`pobranie ${url}: `) && !error.message.includes('przekroczono czas'));
});

test('klient https: limit rozmiaru i czas oczekiwania', { skip: SKIP }, async (t) => {
  const server = await serve(t, (req, res) => {
    if (req.url === '/dokladnie') return res.end(Buffer.alloc(5000000, 97));
    if (req.url === '/za-duzo') return res.end(Buffer.alloc(5000001, 97));
    return undefined;
  }, { timeoutMs: 300 });
  const exact = await server.fetch(`${server.base}/dokladnie`);
  assert.equal(exact.length, 5000000, 'dokładnie limit jest jeszcze dozwolony');
  await assert.rejects(server.fetch(`${server.base}/za-duzo`), (error) => error instanceof sync.SyncError && error.message === `odpowiedź za duża: ${server.base}/za-duzo`);
  await assert.rejects(server.fetch(`${server.base}/cisza`), (error) => error instanceof sync.SyncError && error.message === `przekroczono czas: ${server.base}/cisza`);
});
