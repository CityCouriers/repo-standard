'use strict';
// Testy dokładnych kontraktów kontroli rozjazdu (komunikaty, granice, wejścia brzegowe), które zabijają mutanty
// niewykrywane przez testy zachowania: treść zgłoszenia i raportów, wejścia ścieżek, wpisy dla podsumowania.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const params = require('../.github/standard/common/params');
const drift = require('../.github/standard/drift/drift_run');
const core = require('../.github/standard/drift/drift_core');
const cs = require('../.github/standard/drift/commit_status');
const { DriftError, makeApi } = require('../.github/standard/drift/drift_api');
const h = require('./helpers');
const f = require('./drift-fake');

const P = params.PARAMS_PATH;
const HASH = String.fromCharCode(35);
const ISSUE5 = `o/r${HASH}5`;
const OTHER_REPO5 = `inne/repo${HASH}5`;
const HEAD = h.fakeSha('mut-head');
const short = (sha) => sha.slice(0, 7);
const BASE7 = short(f.BASE_SHA);
const goodTree = (extra = {}) => ({ [P]: f.paramsText(), [f.FILE]: f.GOOD, [f.OTHER]: 'module.exports = 2;\n', ...extra });
const pr = (head, { tree = goodTree(), files = [{ filename: f.FILE }], base = 'main' } = {}) => ({ head, base, files, tree });
const DRIFTED = { files: { [f.FILE]: 'zły\n', [f.OTHER]: 'module.exports = 2;\n' } };
const SUM = 'rozjazd, suma SHA-256 różni się od manifestu';

function setup({ prs, patch, issues, files, apiMap = {}, releases } = {}) {
  const net = f.standardNet(releases || { [f.SHA1]: { rel: f.release(), tag: 'v1.0.0' } });
  const gh = f.fakeGitHub({ prs, issues });
  const workspace = f.workspace({ patch, files });
  const deps = { api: gh.api, fetch: net.fetch, workspace, apiGet: f.issueApi(apiMap) };
  return { gh, workspace, deps, run: (argv, env = {}) => f.runDrift(argv, { env, deps }) };
}

// ------------------------------------------------------------------ drift_core

test('core: stałe znaczniki mają dokładną postać', () => {
  assert.equal(core.MARKER, '<!-- repo-standard-drift -->');
  assert.equal(core.CONTEXT, 'standard-drift');
  assert.equal(core.BOT, 'github-actions[bot]');
});

test('core: odcisk rozróżnia sąsiednie wpisy (separator) a storedFingerprint wymaga pełnej linii', () => {
  assert.notEqual(core.fingerprint(['a', 'b']), core.fingerprint(['ab']));
  const fp = core.fingerprint(['a']);
  assert.equal(core.storedFingerprint(`${core.MARKER}\n<!-- fingerprint: ${fp} -->x`), null);
  assert.equal(core.storedFingerprint(`${core.MARKER}\n<!-- fingerprint: ${fp} -->`), fp);
});

const DRIFT = { repo: 'o/r', version: 'v1.0.0', findings: ['b: rozjazd', 'a: brak pliku', 'a: brak pliku'] };

test('core: treść zgłoszenia jest dokładnie taka, jak w kontrakcie', () => {
  const expected = [
    '<!-- repo-standard-drift -->',
    `<!-- fingerprint: ${core.fingerprint(DRIFT.findings)} -->`,
    '## Rozjazd wzorca',
    '',
    'Repozytorium `o/r`, wzorzec `v1.0.0`. Rozbieżności: 2.',
    '',
    '```text',
    'a: brak pliku',
    'b: rozjazd',
    '```',
    '',
    'Naprawa: `node .github/standard/standard_sync.js apply --version v1.0.0`, przegląd wyniku i zwykły PR.',
    'Poprawka znaleziona u konsumenta wraca do wzorca: https://github.com/CityCouriers/repo-standard#poprawka-z-konsumenta',
    '',
    '_Zgłoszenie prowadzi automat `standard-drift` (jedno na repozytorium). Treść jest nadpisywana przy zmianie listy, a zgłoszenie zamykane, gdy rozjazd ustanie._',
  ].join('\n');
  assert.equal(core.renderIssue(DRIFT).body, expected);
});

test('core: lista dokładnie MAX_LISTED pozycji nie ma wiersza o pominiętych, o jedną więcej ma', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(3, '0')}`);
  assert.ok(!core.renderIssue({ ...DRIFT, findings: make(core.MAX_LISTED) }).body.includes('kolejnych'));
  assert.ok(core.renderIssue({ ...DRIFT, findings: make(core.MAX_LISTED + 1) }).body.includes('\n... i 1 kolejnych (pełna lista w podsumowaniu przebiegu)'));
});

test('core: komentarz o zmianie listy ma dokładną treść z 12 znakami odcisku', () => {
  const old = core.renderIssue(DRIFT).body;
  const issue = { number: 5, state: 'open', user: { login: core.BOT }, labels: core.LABELS.map((name) => ({ name })), body: old };
  const changed = { ...DRIFT, findings: ['c: rozjazd'] };
  const plan = core.planIssue([issue], changed);
  assert.equal(plan.ops[1].comment, `Lista różnic zmieniła się (odcisk ${core.fingerprint(changed.findings).slice(0, 12)}). Aktualna lista jest w treści zgłoszenia.`);
});

// ------------------------------------------------------------------ drift_api

test('api: odpowiedź złożona z samych białych znaków to null', () => {
  assert.equal(makeApi(() => '\n  \n').send('POST', 'repos/o/r/statuses/abc', {}), null);
});

test('api: segmenty "." i ".." przed zapytaniem są odrzucone z dokładnym komunikatem, kropki w nazwach przechodzą', () => {
  const calls = [];
  const api = makeApi((args) => { calls.push(args); return '{}'; });
  for (const bad of ['repos/o/r/./x', 'repos/o/r/a/./b', 'repos/o/r/a/..', 'repos/o/r/x/../y?ref=1']) {
    assert.throws(() => api.get(bad), (error) => error instanceof DriftError && error.message === `niedozwolona ścieżka API: ${bad}`, bad);
  }
  assert.equal(calls.length, 0);
  api.get('repos/o.x/r.y/contents/a.b.js?ref=abc');
  api.get('repos/o/r/contents/.github/x.js?ref=1.2');
  assert.equal(calls.length, 2);
});

// ------------------------------------------------------------------ commit_status

test('commit_status: readPrHead odrzuca brakujące head i sha jako DriftError, nie TypeError', () => {
  for (const body of [null, {}, { head: null }, { head: {} }]) {
    assert.throws(() => cs.readPrHead({ get: () => body }, f.REPO, 1), (error) => error instanceof DriftError && /PR 1: HEAD: oczekiwano pełnego SHA/.test(error.message), JSON.stringify(body));
  }
});

test('commit_status: validSha odrzuca obiekt, który tylko wygląda jak SHA', () => {
  assert.throws(() => cs.validSha({ toString: () => HEAD }, 'x'), DriftError);
  assert.equal(cs.validSha(HEAD, 'x'), HEAD);
});

// ------------------------------------------------------------------ drift_run: odczyt i zapis plików

test('readHeadFile: dokładne komunikaty błędów i odrzucenie niepoprawnych odpowiedzi', () => {
  const stub = (entry) => ({ get: () => entry });
  const tooBig = /^DriftError: x: API nie zwróciło treści pliku \(zbyt duży\?\)$/;
  assert.throws(() => drift.readHeadFile(stub({ type: 'file', encoding: 'none', content: '', size: 2 }), f.REPO, HEAD, 'x'), tooBig);
  assert.throws(() => drift.readHeadFile(stub({ type: 'file', encoding: 'base64', content: 5, size: 1 }), f.REPO, HEAD, 'x'), tooBig);
  assert.throws(() => drift.readHeadFile(stub({ type: 'file', encoding: 'base64', size: 1 }), f.REPO, HEAD, 'x'), tooBig);
  assert.throws(() => drift.readHeadFile(stub({ type: 'file', encoding: 'none', content: 'YQ==', size: 1 }), f.REPO, HEAD, 'x'), tooBig);
  assert.throws(() => drift.readHeadFile(stub({ type: 'file', encoding: 'base64', content: 'YWJj', size: 99 }), f.REPO, HEAD, 'x'), /^DriftError: x: rozmiar treści nie zgadza się z odpowiedzią API$/);
  for (const nothing of [null, 'tekst', 5, [], { type: 'symlink' }, {}]) assert.equal(drift.readHeadFile(stub(nothing), f.REPO, HEAD, 'x'), null, JSON.stringify(nothing));
  assert.equal(drift.readHeadFile(stub({ type: 'file', encoding: 'base64', content: 'YWJj', size: 3 }), f.REPO, HEAD, 'x').toString(), 'abc');
});

test('materialize: katalog z prefiksem standard-drift-, dokładny komunikat odmowy', () => {
  const gh = f.fakeGitHub({ prs: { 1: pr(HEAD) } });
  const root = drift.materialize(gh.api, f.REPO, HEAD, [f.FILE]);
  try {
    assert.ok(path.basename(root).startsWith('standard-drift-'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.throws(() => drift.materialize(gh.api, f.REPO, HEAD, ['../evil.js']), /^DriftError: niedozwolona ścieżka pliku wzorca: \.\.\/evil\.js$/);
});

// ------------------------------------------------------------------ drift_run: konfiguracja

test('main: GITHUB_REPOSITORY musi być w całości w postaci wlasciciel/repo, GITHUB_SHA pełnym SHA', async () => {
  const s = setup();
  for (const bad of ['o/r/x', ' o/r', 'o/r ', 'o/', '/r', 'o', undefined]) {
    const { code, out } = await s.run(['check'], { GITHUB_REPOSITORY: bad });
    assert.equal(code, 2, String(bad));
    assert.match(out, /^## standard-drift: przerwano\n- DriftError: GITHUB_REPOSITORY: oczekiwano postaci wlasciciel\/repo$/);
  }
  const accepted = await f.runDrift(['check'], { env: { GITHUB_REPOSITORY: 'owner/repo' }, deps: s.deps });
  assert.ok(!/GITHUB_REPOSITORY/.test(accepted.out));
  for (const bad of [undefined, '', 'abc', f.BASE_SHA.toUpperCase()]) {
    const { code, out } = await s.run(['check'], { GITHUB_SHA: bad });
    assert.equal(code, 2);
    assert.match(out, /DriftError: GITHUB_SHA: oczekiwano pełnego SHA/);
  }
});

test('main: bez deps.now używa bieżącej daty, z deps.now używa podanej (odstępstwo ważne tylko w podanej dacie)', async () => {
  const s = setup();
  const drifted = await f.runDrift(['check'], { deps: { ...s.deps, now: undefined } });
  assert.equal(drifted.code, 0);
  const files = { [f.FILE]: f.GOOD, [f.OTHER]: 'zły\n' };
  const override = { overrides: [{ path: f.OTHER, reason: 'powód', until: '2026-11-15', issue: ISSUE5 }] };
  const open = setup({ files, patch: override, apiMap: { 5: {} } });
  assert.equal((await open.run(['check'])).code, 0);
});

test('check: weryfikacja odstępstw przez API: uznane daje 0, zamknięte zgłoszenie 1', async () => {
  const files = { [f.FILE]: f.GOOD, [f.OTHER]: 'zły\n' };
  const patch = { overrides: [{ path: f.OTHER, reason: 'powód', until: '2026-12-01', issue: ISSUE5 }] };
  assert.equal((await setup({ files, patch, apiMap: { 5: {} } }).run(['check'])).code, 0);
  const closed = await setup({ files, patch, apiMap: { 5: { state: 'closed' } } }).run(['check']);
  assert.equal(closed.code, 1);
  assert.match(closed.out, /nieuznane: zgłoszenie nie jest otwarte/);
});

// ------------------------------------------------------------------ drift_run: dokładne raporty

test('raport: kontrola gałęzi (zgodna i z rozjazdem) ma dokładne wyjście', async () => {
  assert.equal((await setup().run(['check'])).out, '## standard-drift (v1.0.0): zgodne\n- pliki zgodne z manifestem');
  assert.equal((await setup(DRIFTED).run(['check'])).out, `## standard-drift (v1.0.0): rozjazd\n- ${f.FILE}: ${SUM}`);
});

test('raport: PR zgodny, wczesne wyjście, poza zakresem i zmiana HEAD mają dokładne wyjście', async () => {
  const clean = await setup({ prs: { 1: pr(HEAD) } }).run(['pr'], { PR_NUMBER: '1' });
  assert.equal(clean.out, `## standard-drift PR 1 (${short(HEAD)}): success`);
  const early = await setup({ prs: { 1: pr(HEAD, { files: [] }) } }).run(['pr'], { PR_NUMBER: '1' });
  assert.equal(early.out, `## standard-drift PR 1 (${short(HEAD)}): success\n- PR nie dotyka plików wzorca ani .github/: wczesne wyjście`);
  const other = await setup({ prs: { 1: pr(HEAD, { base: 'inna' }) } }).run(['pr'], { PR_NUMBER: '1' });
  assert.equal(other.out, '## standard-drift PR 1\n- PR do gałęzi inna, nie do domyślnej (main): poza zakresem');
  const NEW = h.fakeSha('mut-new');
  let reads = 0;
  const gh = f.fakeGitHub({ prs: { 1: pr(HEAD) }, hooks: { onGet: (p, state) => { if (p === 'repos/o/r/pulls/1' && ++reads === 3) state.prs[1].head = NEW; } } });
  const moved = await f.runDrift(['pr'], { env: { PR_NUMBER: '1' }, deps: { api: gh.api, fetch: f.standardNet({ [f.SHA1]: { rel: f.release(), tag: 'v1.0.0' } }).fetch, workspace: f.workspace(), apiGet: f.issueApi({}) } });
  assert.equal(moved.out, `## standard-drift PR 1\n- HEAD zmienił się w trakcie biegu (${short(HEAD)} na ${short(NEW)}): wynik nie zapisany`);
});

test('raport: brak i niepoprawny plik parametrów w HEAD mają dokładny stan, opis i linię', async () => {
  const noParams = goodTree();
  delete noParams[P];
  const a = setup({ prs: { 1: pr(HEAD, { tree: noParams }) } });
  const missing = await a.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(missing.out, `## standard-drift PR 1 (${short(HEAD)}): failure\n- ${P}: brak pliku w HEAD PR`);
  assert.deepEqual(a.gh.statuses.map((s) => [s.state, s.description]), [['pending', `kontrola w toku (baza ${BASE7})`], ['failure', `brak ${P} w HEAD PR`]]);
  const b = setup({ prs: { 1: pr(HEAD, { tree: goodTree({ [P]: '{ nie json' }) }) } });
  const broken = await b.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(broken.code, 1);
  assert.deepEqual(b.gh.statuses.map((s) => [s.state, s.description]), [['pending', `kontrola w toku (baza ${BASE7})`], ['failure', 'plik parametrów w HEAD PR niepoprawny']]);
  assert.match(broken.out, /^## standard-drift PR 1 \(\w{7}\): failure\n- plik parametrów niepoprawny: /);
});

test('raport: push na gałęzi nie-domyślnej i w trybie strict ma dokładne wyjście', async () => {
  const other = await setup({ prs: { 1: pr(HEAD) } }).run(['push'], { GITHUB_REF_NAME: 'inna' });
  assert.equal(other.out, '## standard-drift push\n- gałąź inna nie jest domyślną (main): poza zakresem');
  const strict = await setup({ prs: { 1: pr(HEAD) }, patch: { drift: { strict: true } } }).run(['push']);
  assert.equal(strict.out, `## standard-drift push (${BASE7})\n- drift.strict=true: aktualność PR wymusza ruleset, reconciler nie przelicza statusów\n## standard-drift (v1.0.0): zgodne\n- pliki zgodne z manifestem`);
});

test('raport: push z jednym PR bez zmian wzorca: pending bez ogłoszenia kontroli, wynik, dokładny raport reconcilera', async () => {
  const s = setup({ prs: { 1: pr(HEAD, { files: [] }) } });
  const { out } = await s.run(['push']);
  assert.deepEqual(s.gh.statuses.map((x) => [x.state, x.description]), [['pending', `przeliczanie po zmianie bazy ${BASE7}`], ['success', `PR nie dotyka plików wzorca (baza ${BASE7})`]]);
  assert.ok(out.endsWith(`## standard-drift push (${BASE7})\n- otwartych PR: 1, przeliczono: 1\n## standard-drift (v1.0.0): zgodne\n- pliki zgodne z manifestem`));
});

test('raport: zgłoszenie rozjazdu ma dokładne wyjście dla założenia, braku zmian, zmiany i zamknięcia', async () => {
  const s = setup(DRIFTED);
  assert.equal((await s.run(['issue'])).out, '## standard-drift zgłoszenie: rozjazd\n- założono zgłoszenie 101');
  assert.equal((await s.run(['issue'])).out, '## standard-drift zgłoszenie: rozjazd\n- zgłoszenie bez zmian');
  fs.writeFileSync(`${s.workspace}/${f.OTHER}`, 'zły też\n');
  assert.equal((await s.run(['issue'])).out, '## standard-drift zgłoszenie: rozjazd\n- zaktualizowano zgłoszenie 101\n- dopisano komentarz w 101');
  fs.writeFileSync(`${s.workspace}/${f.FILE}`, f.GOOD);
  fs.writeFileSync(`${s.workspace}/${f.OTHER}`, 'module.exports = 2;\n');
  assert.equal((await s.run(['issue'])).out, '## standard-drift zgłoszenie: zgodne\n- zamknięto zgłoszenie 101');
  assert.equal((await s.run(['issue'])).out, '## standard-drift zgłoszenie: zgodne\n- zgłoszenie bez zmian');
});

// ------------------------------------------------------------------ drift_run: podsumowanie przebiegu i wejście

test('podsumowanie: GITHUB_STEP_SUMMARY dostaje nagłówek i listę; bez zmiennej nic nie jest zapisywane ani zgłaszane', async () => {
  const dir = h.tmpDir('drift-sum-');
  const file = path.join(dir, 'summary.md');
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const s = setup(DRIFTED);
    await s.run(['check'], { GITHUB_STEP_SUMMARY: file });
    assert.equal(fs.readFileSync(file, 'utf8'), `## standard-drift (v1.0.0): rozjazd\n\n- ${f.FILE}: ${SUM}\n\n`);
    assert.deepEqual(errors, []);
    await setup().run(['check']);
    assert.deepEqual(errors, []);
    const broken = await setup().run(['check'], { GITHUB_STEP_SUMMARY: path.join(dir, 'brak', 'x.md') });
    assert.equal(broken.code, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^nie zapisano podsumowania: ENOENT/);
  } finally {
    console.error = original;
    h.rmDir(dir);
  }
});

test('wejście skryptu: uruchomiony wprost kończy się kodem 2 i komunikatem użycia (kod wyjścia ustawiony)', () => {
  const script = path.join(h.REPO_ROOT, '.github', 'standard', 'drift', 'drift_run.js');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /użycie: drift_run\.js pr \| push \| check \| issue/);
});

test('PR dotykający pliku wzorca spoza .github/ (z manifestu) dostaje pełną kontrolę, PR bez niego wczesne wyjście', async () => {
  const S = 'scripts/ci/s.sh';
  const rel = f.release('v1.0.0', { [f.FILE]: f.GOOD, [f.OTHER]: 'module.exports = 2;\n', [S]: 's\n' }, [S]);
  const releases = { [f.SHA1]: { rel, tag: 'v1.0.0' } };
  const full = setup({ prs: { 1: pr(HEAD, { files: [{ filename: S }] }) }, releases });
  const { code, out } = await full.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 1);
  assert.match(out, /scripts\/ci\/s\.sh: brak pliku/);
  const early = setup({ prs: { 1: pr(HEAD, { files: [{ filename: 'README.md' }] }) }, releases });
  assert.equal((await early.run(['pr'], { PR_NUMBER: '1' })).code, 0);
});

test('wejście skryptu: argumenty po nazwie skryptu trafiają do main (komenda check dociera do kontroli konfiguracji)', () => {
  const script = path.join(h.REPO_ROOT, '.github', 'standard', 'drift', 'drift_run.js');
  const result = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '' } });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /GITHUB_REPOSITORY: oczekiwano postaci wlasciciel\/repo/);
  assert.ok(!/użycie:/.test(result.stdout));
});

test('podsumowanie: kilka linii w pliku podsumowania jest rozdzielonych samymi znakami nowej linii', async () => {
  const dir = h.tmpDir('drift-sum2-');
  const file = path.join(dir, 'summary.md');
  try {
    const s = setup({ files: { [f.FILE]: 'zły\n', [f.OTHER]: 'zły też\n' } });
    await s.run(['check'], { GITHUB_STEP_SUMMARY: file });
    assert.equal(fs.readFileSync(file, 'utf8'), `## standard-drift (v1.0.0): rozjazd\n\n- ${f.FILE}: ${SUM}\n- ${f.OTHER}: ${SUM}\n\n`);
  } finally {
    h.rmDir(dir);
  }
});
