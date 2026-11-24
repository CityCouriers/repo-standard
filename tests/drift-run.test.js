'use strict';
// Testy zachowania kontroli rozjazdu (`drift_run.js`) na atrapie API GitHuba i atrapie sieci wzorca: kontrola PR
// z jawnym statusem, reconciler po zmianie domyślnej gałęzi, kontrola gałęzi, zgłoszenie rozjazdu, nieufny HEAD.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const params = require('../.github/standard/common/params');
const drift = require('../.github/standard/drift/drift_run');
const core = require('../.github/standard/drift/drift_core');
const { DriftError } = require('../.github/standard/drift/drift_api');
const h = require('./helpers');
const f = require('./drift-fake');

const P = params.PARAMS_PATH;
const HASH = String.fromCharCode(35);
const ISSUE5 = `o/r${HASH}5`;
const OTHER_REPO5 = `inne/repo${HASH}5`;
const HEAD = h.fakeSha('head-1');
const short = (sha) => sha.slice(0, 7);
const goodTree = (extra = {}) => ({ [P]: f.paramsText(), [f.FILE]: f.GOOD, [f.OTHER]: 'module.exports = 2;\n', ...extra });
const pr = (head, { tree = goodTree(), files = [{ filename: f.FILE }], base = 'main' } = {}) => ({ head, base, files, tree });
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('standard-drift-')).length;

function setup({ prs, patch, hooks, issues, rel = f.release(), releases, apiMap = {}, files } = {}) {
  const net = f.standardNet(releases || { [f.SHA1]: { rel, tag: 'v1.0.0' } });
  const gh = f.fakeGitHub({ prs, hooks, issues });
  const workspace = f.workspace({ patch, files });
  const deps = { api: gh.api, fetch: net.fetch, workspace, apiGet: f.issueApi(apiMap) };
  return { net, gh, workspace, deps, run: (argv, env = {}) => f.runDrift(argv, { env, deps }) };
}

const states = (gh) => gh.statuses.map((status) => `${status.sha.slice(0, 7)}:${status.state}`);

// ------------------------------------------------------------------ pr

test('pr: zgodny PR dostaje pending, potem success na HEAD odczytanym z API; kontekst stały', async () => {
  const s = setup({ prs: { 1: pr(HEAD) } });
  const before = tmpLeft();
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses.map((status) => [status.sha, status.state, status.context]), [[HEAD, 'pending', 'standard-drift'], [HEAD, 'success', 'standard-drift']]);
  assert.equal(s.gh.statuses[0].description, `kontrola w toku (baza ${short(f.BASE_SHA)})`);
  assert.equal(s.gh.statuses[1].description, `zgodne z wzorcem v1.0.0 (baza ${short(f.BASE_SHA)})`);
  assert.match(out, /^## standard-drift PR 1 \(/);
  assert.equal(tmpLeft(), before);
  assert.equal(s.gh.log.filter((line) => line.startsWith('GET repos/o/r/contents/')).length, 4);
});

test('pr: rozjazd pliku wzorca w HEAD: pending, potem failure z liczbą i pierwszym rozjazdem, kod 1', async () => {
  const s = setup({ prs: { 1: pr(HEAD, { tree: goodTree({ [f.FILE]: 'module.exports = 99;\n' }) }) } });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 1);
  assert.deepEqual(states(s.gh), [`${short(HEAD)}:pending`, `${short(HEAD)}:failure`]);
  assert.equal(s.gh.statuses[1].description, `rozjazd wzorca v1.0.0: 1 (${f.FILE}: rozjazd, suma SHA-256 różni się od manifestu)`.slice(0, 140));
  assert.match(out, /rozjazd, suma SHA-256/);
});

test('pr: PR niedotykający plików wzorca kończy się success bez pobierania plików HEAD', async () => {
  const s = setup({ prs: { 1: pr(HEAD, { files: [{ filename: 'README.md' }, { filename: 'src/a.js' }] }) } });
  const { code } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 0);
  assert.equal(s.gh.statuses[1].state, 'success');
  assert.equal(s.gh.statuses[1].description, `PR nie dotyka plików wzorca (baza ${short(f.BASE_SHA)})`);
  assert.equal(s.gh.log.some((line) => line.includes('/contents/')), false);
});

test('pr: PR do gałęzi innej niż domyślna jest poza zakresem, bez żadnego statusu', async () => {
  const s = setup({ prs: { 1: pr(HEAD, { base: 'inna' }) } });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses, []);
  assert.match(out, /poza zakresem/);
});

test('pr: HEAD zmieniony w trakcie biegu: wynik nie jest zapisany, zostaje pending', async () => {
  let reads = 0;
  const NEW = h.fakeSha('head-2');
  const s = setup({
    prs: { 1: pr(HEAD) },
    hooks: { onGet: (path, state) => { if (path === 'repos/o/r/pulls/1' && ++reads === 3) state.prs[1].head = NEW; } },
  });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 0);
  assert.deepEqual(states(s.gh), [`${short(HEAD)}:pending`]);
  assert.match(out, new RegExp(`HEAD zmienił się w trakcie biegu \\(${short(HEAD)} na ${short(NEW)}\\)`));
});

test('pr: błąd API w trakcie kontroli to failure (nigdy success) i kod 2', async () => {
  const s = setup({
    prs: { 1: pr(HEAD) },
    hooks: { onGet: (path) => { if (path.includes('/contents/')) throw new DriftError(`gh api ${path}: HTTP 502`); } },
  });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 2);
  assert.deepEqual(states(s.gh), [`${short(HEAD)}:pending`, `${short(HEAD)}:failure`]);
  assert.match(s.gh.statuses[1].description, /^błąd działania: gh api repos\/o\/r\/contents\//);
  assert.match(out, /DriftError: gh api/);
});

test('pr: błąd sieci wzorca (manifest) to failure i kod 2', async () => {
  const s = setup({ prs: { 1: pr(HEAD) }, releases: {} });
  const { code } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 2);
  assert.deepEqual(states(s.gh), [`${short(HEAD)}:pending`, `${short(HEAD)}:failure`]);
});

test('pr: błąd zapisu pending przerywa bieg kodem 2 bez żadnego statusu sukcesu', async () => {
  const s = setup({
    prs: { 1: pr(HEAD) },
    hooks: { onSend: (method, path) => { if (path.includes('/statuses/')) throw new DriftError('gh api: HTTP 403'); } },
  });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 2);
  assert.deepEqual(s.gh.statuses, []);
  assert.match(out, /standard-drift: przerwano/);
});

test('pr: PR_NUMBER musi być zapisem dziesiętnym dodatniej liczby całkowitej', async () => {
  for (const bad of ['', '0', '-1', '1.5', 'abc', '007', '1e3', ' 1', '9007199254740993']) {
    const s = setup({ prs: { 1: pr(HEAD) } });
    const { code, out } = await s.run(['pr'], { PR_NUMBER: bad });
    assert.equal(code, 2, JSON.stringify(bad));
    assert.match(out, /PR_NUMBER: oczekiwano numeru PR/);
    assert.deepEqual(s.gh.statuses, []);
  }
  const s = setup({ prs: {} });
  assert.equal((await s.run(['pr'], {})).code, 2);
});

test('pr: HEAD bez poprawnego SHA to błąd bez statusu', async () => {
  const s = setup({ prs: { 1: pr('abc') } });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 2);
  assert.match(out, /HEAD: oczekiwano pełnego SHA/);
  assert.deepEqual(s.gh.statuses, []);
});

test('pr: brak pliku parametrów w HEAD i niepoprawny plik parametrów to failure kodu 1', async () => {
  const noParams = goodTree();
  delete noParams[P];
  let s = setup({ prs: { 1: pr(HEAD, { tree: noParams }) } });
  assert.equal((await s.run(['pr'], { PR_NUMBER: '1' })).code, 1);
  assert.equal(s.gh.statuses[1].state, 'failure');
  assert.equal(s.gh.statuses[1].description, `brak ${P} w HEAD PR`);
  s = setup({ prs: { 1: pr(HEAD, { tree: goodTree({ [P]: '{ nie json' }) }) } });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 1);
  assert.equal(s.gh.statuses[1].description, 'plik parametrów w HEAD PR niepoprawny');
  assert.match(out, /plik parametrów niepoprawny/);
});

test('pr: brak pliku parametrów na domyślnej gałęzi to błąd działania (zaufany pin nieznany)', async () => {
  const s = setup({ prs: { 1: pr(HEAD) } });
  fs.rmSync(`${s.workspace}/${P}`);
  const { code } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 2);
  assert.equal(s.gh.statuses[1].state, 'failure');
  assert.match(s.gh.statuses[1].description, /brak \.github\/repo-standard\.json na domyślnej gałęzi/);
});

test('pr: brak pliku wzorca w HEAD to rozjazd; dowiązanie, katalog i moduł zamiast pliku też', async () => {
  for (const entry of [undefined, { type: 'symlink', target: '/etc/passwd' }, [{ name: 'x' }], { type: 'submodule' }, null]) {
    const tree = goodTree();
    if (entry === undefined) delete tree[f.FILE]; else tree[f.FILE] = entry;
    const s = setup({ prs: { 1: pr(HEAD, { tree }) } });
    const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
    assert.equal(code, 1, JSON.stringify(entry));
    assert.ok(out.includes(`${f.FILE}: brak pliku`));
  }
});

test('pr: zbyt duży plik (API bez treści) i niezgodny rozmiar to błąd działania, nie rozjazd i nie sukces', async () => {
  for (const entry of [{ type: 'file', encoding: 'none', content: '', size: 2000000 }, { type: 'file', encoding: 'base64', content: f.b64('abc'), size: 99 }, { type: 'file', encoding: 'base64', content: 5, size: 1 }]) {
    const s = setup({ prs: { 1: pr(HEAD, { tree: goodTree({ [f.FILE]: entry }) }) } });
    const { code } = await s.run(['pr'], { PR_NUMBER: '1' });
    assert.equal(code, 2);
    assert.equal(s.gh.statuses[1].state, 'failure');
  }
});

test('pr: zmiana pinu na tag wydania potwierdzony w API wzorca: sprawdzenie względem nowego wydania, notatka w wyniku', async () => {
  const Z = '.github/standard/z.js';
  const rel2 = f.release('v1.1.0', { [f.FILE]: 'module.exports = 11;\n', [f.OTHER]: 'module.exports = 2;\n', [Z]: 'z\n' }, [Z]);
  const releases = { [f.SHA1]: { rel: f.release(), tag: 'v1.0.0' }, [f.SHA2]: { rel: rel2, tag: 'v1.1.0' } };
  const tree = goodTree({ [Z]: 'z\n', [f.FILE]: 'module.exports = 11;\n', [P]: f.paramsText({ standard: { version: 'v1.1.0', sha: f.SHA2 } }) });
  const s = setup({ prs: { 1: pr(HEAD, { tree }) }, releases });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 0);
  assert.equal(s.gh.statuses[1].state, 'success');
  assert.equal(s.gh.statuses[1].description, `zgodne z wzorcem v1.1.0 (baza ${short(f.BASE_SHA)})`);
  assert.match(out, /PR zmienia wzorzec z v1\.0\.0 na v1\.1\.0/);
});

test('pr: pin z HEAD bez tagu albo ze złym SHA nie jest uznany: pin bazy i rozjazd, bez pobrania cudzego manifestu', async () => {
  const rel2 = f.release('v1.1.0', { [f.FILE]: 'module.exports = 11;\n', [f.OTHER]: 'module.exports = 2;\n' });
  const tree = goodTree({ [f.FILE]: 'module.exports = 11;\n', [P]: f.paramsText({ standard: { version: 'v1.1.0', sha: f.SHA2 } }) });
  for (const releases of [
    { [f.SHA1]: { rel: f.release(), tag: 'v1.0.0' }, [f.SHA2]: { rel: rel2 } },
    { [f.SHA1]: { rel: f.release(), tag: 'v1.0.0' }, [f.SHA2]: { rel: rel2, tag: 'v1.1.0' }, tampered: true },
  ]) {
    const tagged = releases.tampered ? { [f.SHA1]: releases[f.SHA1], [f.SHA2]: { rel: rel2 } } : releases;
    const s = setup({ prs: { 1: pr(HEAD, { tree }) }, releases: tagged });
    const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
    assert.equal(code, 1);
    assert.equal(s.gh.statuses[1].state, 'failure');
    assert.match(out, /zmiana wersji w PR nieuznana/);
    assert.equal(s.net.calls.some((url) => url.includes(f.SHA2) && url.endsWith('manifest.json')), false);
  }
});

test('pr: odstępstwo z otwartym zgłoszeniem z audit:ok uznane (success); zamknięte, bez etykiety, PR zamiast zgłoszenia: failure', async () => {
  const drifted = { [f.OTHER]: 'module.exports = 777;\n', [P]: f.paramsText({ overrides: [{ path: f.OTHER, reason: 'powód', until: '2026-12-01', issue: ISSUE5 }] }) };
  const cases = [
    [{ 5: {} }, 0, 'success'],
    [{ 5: { state: 'closed' } }, 1, 'failure'],
    [{ 5: { labels: ['audit:pending'] } }, 1, 'failure'],
    [{ 5: { pull_request: true } }, 1, 'failure'],
  ];
  for (const [apiMap, expectedCode, expectedState] of cases) {
    const s = setup({ prs: { 1: pr(HEAD, { tree: goodTree(drifted) }) }, apiMap });
    const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
    assert.equal(code, expectedCode, JSON.stringify(apiMap));
    assert.equal(s.gh.statuses[1].state, expectedState);
    if (expectedCode === 0) assert.match(out, /odstępstwo .*: uznane do 2026-12-01/);
  }
});

test('pr: błąd API przy weryfikacji odstępstwa to failure i kod 2 (nie uznane)', async () => {
  const drifted = { [f.OTHER]: 'module.exports = 777;\n', [P]: f.paramsText({ overrides: [{ path: f.OTHER, reason: 'powód', until: '2026-12-01', issue: ISSUE5 }] }) };
  const s = setup({ prs: { 1: pr(HEAD, { tree: goodTree(drifted) }) }, apiMap: {} });
  const { code } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 2);
  assert.equal(s.gh.statuses[1].state, 'failure');
});

test('pr: nieufny HEAD: złośliwe wartości w odstępstwach i nazwy plików są danymi, wynik i opis bez znaków sterujących', async () => {
  const evil = '$(touch /tmp/x)\n::set-output name=a::b\n::add-mask::x\nGITHUB_ENV=a=b';
  const tree = goodTree({
    [f.OTHER]: 'module.exports = 777;\n',
    [P]: f.paramsText({ overrides: [{ path: f.OTHER, reason: evil, until: '2026-12-01', issue: ISSUE5 }] }),
  });
  const files = [{ filename: `.github/${evil}` }, { filename: '../../etc/passwd' }, { filename: '/abs/x', previous_filename: `a\n::error::${evil}` }, { filename: f.FILE }];
  const s = setup({ prs: { 1: pr(HEAD, { tree, files }) }, apiMap: { 5: { state: 'closed' } } });
  const before = tmpLeft();
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1', GITHUB_ENV: '/nie/ma/takiego', GITHUB_OUTPUT: '/nie/ma/takiego' });
  assert.equal(code, 1);
  assert.equal(tmpLeft(), before);
  for (const line of out.split('\n')) assert.ok(line === '' || line.startsWith('## ') || line.startsWith('- '), line);
  assert.ok(!/[\r]/.test(JSON.stringify(s.gh.statuses).replace(/\\r/g, '\r')));
  for (const status of s.gh.statuses) assert.ok(!/[\n\r]/.test(status.description));
});

test('pr: złośliwe wartości w odstępstwie (issue z metaznakami, ścieżka poza manifestem) to błąd schematu, nie wykonanie', async () => {
  for (const override of [
    { path: f.OTHER, reason: 'x', until: '2026-12-01', issue: 'o/r#$(id)' },
    { path: '../../x', reason: 'x', until: '2026-12-01', issue: ISSUE5 },
    { path: f.OTHER, reason: 'x', until: '2026-12-01', issue: OTHER_REPO5 },
  ]) {
    const s = setup({ prs: { 1: pr(HEAD, { tree: goodTree({ [f.OTHER]: 'zły\n', [P]: f.paramsText({ overrides: [override] }) }) }) } });
    const { code } = await s.run(['pr'], { PR_NUMBER: '1' });
    assert.notEqual(code, 0, JSON.stringify(override));
    assert.notEqual(s.gh.statuses.at(-1).state, 'success');
  }
});

test('materialize: ścieżka z .., bezwzględna, pusta lub z "." segmentem jest odrzucona, katalog tymczasowy usunięty', () => {
  const gh = f.fakeGitHub({ prs: { 1: pr(HEAD) } });
  const before = tmpLeft();
  for (const bad of ['../evil.js', '/abs/evil.js', 'a//b.js', './a.js', 'a/./b.js', 'a/../b.js', '']) {
    assert.throws(() => drift.materialize(gh.api, f.REPO, HEAD, [f.FILE, bad]), DriftError, JSON.stringify(bad));
  }
  assert.equal(tmpLeft(), before);
  const root = drift.materialize(gh.api, f.REPO, HEAD, [f.FILE, '.github/brak.js']);
  try {
    assert.equal(fs.readFileSync(`${root}/${f.FILE}`, 'utf8'), f.GOOD);
    assert.equal(fs.existsSync(`${root}/.github/brak.js`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readHeadFile: 404 to null, inny błąd to wyjątek, treść dekodowana z base64', () => {
  const gh = f.fakeGitHub({ prs: { 1: pr(HEAD, { tree: { 'a b.txt': 'zażółć' } }) } });
  assert.equal(drift.readHeadFile(gh.api, f.REPO, HEAD, 'a b.txt').toString('utf8'), 'zażółć');
  assert.equal(drift.readHeadFile(gh.api, f.REPO, HEAD, 'brak.txt'), null);
  assert.ok(gh.log.some((line) => line.includes('contents/a%20b.txt?ref=')));
  const failing = { get: () => { throw new DriftError('gh api: HTTP 500'); } };
  assert.throws(() => drift.readHeadFile(failing, f.REPO, HEAD, 'x'), /HTTP 500/);
  const plain = { get: () => { throw new Error('inny'); } };
  assert.throws(() => drift.readHeadFile(plain, f.REPO, HEAD, 'x'), /inny/);
  const notDrift = { get: () => { throw Object.assign(new Error('x'), { notFound: true }); } };
  assert.throws(() => drift.readHeadFile(notDrift, f.REPO, HEAD, 'x'), /x/);
});

// ------------------------------------------------------------------ push (reconciler)

const heads = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, pr(h.fakeSha(`h${i + 1}`), { files: [] })]));

test('push: pending na HEAD wszystkich otwartych PR jest pierwszym krokiem, dopiero potem przeliczenie z SHA bazy', async () => {
  const s = setup({ prs: { 1: pr(h.fakeSha('h1')), 2: pr(h.fakeSha('h2'), { files: [{ filename: 'README.md' }] }) } });
  const { code, out } = await s.run(['push']);
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses.map((status) => status.state), ['pending', 'pending', 'success', 'success']);
  assert.equal(s.gh.statuses[0].description, `przeliczanie po zmianie bazy ${short(f.BASE_SHA)}`);
  assert.equal(s.gh.statuses[2].description, `zgodne z wzorcem v1.0.0 (baza ${short(f.BASE_SHA)})`);
  assert.equal(s.gh.statuses[3].description, `PR nie dotyka plików wzorca (baza ${short(f.BASE_SHA)})`);
  assert.match(out, /otwartych PR: 2, przeliczono: 2/);
  assert.match(out, /standard-drift \(v1\.0\.0\): zgodne/);
  const firstContents = s.gh.log.findIndex((line) => line.includes('/contents/'));
  const lastPending = s.gh.log.map((line, i) => (line.startsWith('POST') ? i : -1)).filter((i) => i >= 0)[1];
  assert.ok(firstContents > lastPending);
});

test('push: rozjazd w PR nie czerwieni biegu na domyślnej gałęzi, ale PR dostaje failure', async () => {
  const s = setup({ prs: { 1: pr(h.fakeSha('h1'), { tree: goodTree({ [f.FILE]: 'zły\n' }) }) } });
  const { code } = await s.run(['push']);
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses.map((status) => status.state), ['pending', 'failure']);
});

test('push: limit przeliczania: ponad MAX_RECALC zostaje pending z komunikatem', async () => {
  const total = core.MAX_RECALC + 3;
  const s = setup({ prs: heads(total) });
  const { code, out } = await s.run(['push']);
  assert.equal(code, 0);
  assert.equal(s.gh.statuses.filter((status) => status.state === 'pending').length, total);
  assert.equal(s.gh.statuses.filter((status) => status.state === 'success').length, core.MAX_RECALC);
  const settled = new Set(s.gh.statuses.filter((status) => status.state === 'success').map((status) => status.sha));
  assert.equal(settled.has(h.fakeSha('h25')), true);
  assert.equal(settled.has(h.fakeSha('h26')), false);
  assert.match(out, /limit przeliczania 25: 3 PR zostaje pending/);
  assert.match(out, new RegExp(`otwartych PR: ${total}, przeliczono: 25`));
});

test('push: dokładnie MAX_RECALC PR nie wypisuje komunikatu o limicie', async () => {
  const s = setup({ prs: heads(core.MAX_RECALC) });
  const { out } = await s.run(['push']);
  assert.ok(!/limit przeliczania/.test(out));
});

test('push: błąd zapisu pending jednego PR: kod 2, ten PR bez wyniku, pozostałe przeliczone', async () => {
  const bad = h.fakeSha('h2');
  const s = setup({
    prs: heads(3),
    hooks: { onSend: (method, path, body) => { if (path.endsWith(bad) && body.state === 'pending') throw new DriftError('gh api: HTTP 403'); } },
  });
  const { code, out } = await s.run(['push']);
  assert.equal(code, 2);
  assert.match(out, /PR 2: nie ustawiono pending: DriftError: gh api: HTTP 403|PR 2: nie ustawiono pending: gh api: HTTP 403/);
  assert.equal(s.gh.statuses.some((status) => status.sha === bad), false);
  assert.equal(s.gh.statuses.filter((status) => status.state === 'success').length, 2);
  assert.match(out, /otwartych PR: 3, przeliczono: 2/);
});

test('push: błąd zapisu wyniku jednego PR: kod 2, komunikat, pozostałe PR przeliczone', async () => {
  const bad = h.fakeSha('h1');
  const s = setup({
    prs: heads(2),
    hooks: { onSend: (method, path, body) => { if (path.endsWith(bad) && body.state !== 'pending') throw new DriftError('gh api: HTTP 500'); } },
  });
  const { code, out } = await s.run(['push']);
  assert.equal(code, 2);
  assert.match(out, /PR 1: przeliczenie nie powiodło się, zostaje pending: gh api: HTTP 500/);
  assert.equal(s.gh.statuses.filter((status) => status.state === 'success').length, 1);
});

test('push: HEAD PR zmieniony w trakcie przeliczania: brak zapisu wyniku dla tego PR', async () => {
  const NEW = h.fakeSha('nowy');
  let reads = 0;
  const s = setup({
    prs: heads(1),
    hooks: { onGet: (path, state) => { if (path === 'repos/o/r/pulls/1' && ++reads === 2) state.prs[1].head = NEW; } },
  });
  const { code } = await s.run(['push']);
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses.map((status) => status.state), ['pending']);
});

test('push: drift.strict=true: reconciler nie dotyka statusów PR, kontrola gałęzi działa', async () => {
  const s = setup({ prs: heads(2), patch: { drift: { strict: true } } });
  const { code, out } = await s.run(['push']);
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses, []);
  assert.equal(s.gh.log.some((line) => line.includes('/pulls?state=open')), false);
  assert.match(out, /drift\.strict=true: aktualność PR wymusza ruleset/);
  assert.match(out, /standard-drift \(v1\.0\.0\): zgodne/);
});

test('push: gałąź inna niż domyślna: bez żadnych zmian', async () => {
  const s = setup({ prs: heads(1) });
  const { code, out } = await s.run(['push'], { GITHUB_REF_NAME: 'inna' });
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses, []);
  assert.match(out, /gałąź inna nie jest domyślną \(main\)/);
});

test('push: rozjazd na samej domyślnej gałęzi czerwieni bieg (wykrycie po scaleniu), statusy PR i tak przeliczone', async () => {
  const s = setup({ prs: heads(1), files: { [f.FILE]: 'zły\n', [f.OTHER]: 'module.exports = 2;\n' } });
  const { code, out } = await s.run(['push']);
  assert.equal(code, 1);
  assert.equal(s.gh.statuses.length, 2);
  assert.match(out, /standard-drift \(v1\.0\.0\): rozjazd/);
});

test('push: błąd odczytu listy PR to kod 2 bez żadnego statusu', async () => {
  const s = setup({
    prs: heads(1),
    hooks: { onGet: (path) => { if (path.includes('/pulls?state=open')) throw new DriftError('gh api: HTTP 502'); } },
  });
  const { code } = await s.run(['push']);
  assert.equal(code, 2);
  assert.deepEqual(s.gh.statuses, []);
});

// ------------------------------------------------------------------ check i zgłoszenie

test('check: zgodna gałąź kod 0, rozjazd kod 1, błąd sieci kod 2', async () => {
  let s = setup();
  assert.equal((await s.run(['check'])).code, 0);
  s = setup({ files: { [f.FILE]: 'zły\n', [f.OTHER]: 'module.exports = 2;\n' } });
  const bad = await s.run(['check']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /rozjazd, suma SHA-256/);
  s = setup({ releases: {} });
  assert.equal((await s.run(['check'])).code, 2);
});

test('main: użycie, brak repozytorium i brak tokenu to kod 2', async () => {
  const s = setup();
  for (const argv of [[], ['x'], ['pr', 'push'], ['toString'], ['__proto__']]) {
    const { code, out } = await s.run(argv);
    assert.equal(code, 2, JSON.stringify(argv));
    assert.match(out, /użycie: drift_run\.js pr \| push \| check \| issue/);
  }
  assert.equal((await s.run(['check'], { GITHUB_REPOSITORY: 'zle' })).code, 2);
  assert.equal((await s.run(['check'], { GITHUB_REPOSITORY: '' })).code, 2);
  const noToken = await s.run(['check'], { GITHUB_TOKEN: '' });
  assert.equal(noToken.code, 2);
  assert.match(noToken.out, /brak GITHUB_TOKEN/);
});

const BOT_ISSUE = (number, body) => ({ number, state: 'open', user: { login: core.BOT }, labels: core.LABELS.map((name) => ({ name })), body });
const DRIFTED = { files: { [f.FILE]: 'zły\n', [f.OTHER]: 'module.exports = 2;\n' } };

test('issue: rozjazd bez zgłoszenia zakłada jedno z etykietami i znacznikiem; drugi bieg nic nie zmienia', async () => {
  const s = setup(DRIFTED);
  const first = await s.run(['issue']);
  assert.equal(first.code, 1);
  assert.equal(s.gh.state.issues.length, 1);
  const created = s.gh.state.issues[0];
  assert.equal(created.title, 'Rozjazd wzorca');
  assert.deepEqual(created.labels.map((label) => label.name), core.LABELS);
  assert.equal(created.body.split('\n')[0], core.MARKER);
  assert.match(first.out, /założono zgłoszenie 101/);
  const second = await s.run(['issue']);
  assert.equal(second.code, 1);
  assert.equal(s.gh.state.issues.length, 1);
  assert.match(second.out, /zgłoszenie bez zmian/);
  assert.equal(s.gh.log.filter((line) => line.startsWith('POST repos/o/r/issues/')).length, 0);
  assert.equal(s.gh.log.filter((line) => line.startsWith('PATCH')).length, 0);
});

test('issue: zmiana listy różnic aktualizuje treść i dopisuje jeden komentarz', async () => {
  const s = setup(DRIFTED);
  await s.run(['issue']);
  fs.writeFileSync(`${s.workspace}/${f.OTHER}`, 'zły też\n');
  const { code, out } = await s.run(['issue']);
  assert.equal(code, 1);
  assert.match(out, /zaktualizowano zgłoszenie 101/);
  assert.match(out, /dopisano komentarz w 101/);
  assert.equal(s.gh.state.issues[0].comments.length, 1);
  assert.ok(s.gh.state.issues[0].body.includes(f.OTHER));
});

test('issue: koniec rozjazdu zamyka zgłoszenie z komentarzem; bez rozjazdu i bez zgłoszenia nic się nie dzieje', async () => {
  const s = setup(DRIFTED);
  await s.run(['issue']);
  fs.writeFileSync(`${s.workspace}/${f.FILE}`, f.GOOD);
  const { code, out } = await s.run(['issue']);
  assert.equal(code, 0);
  assert.match(out, /zamknięto zgłoszenie 101/);
  assert.equal(s.gh.state.issues[0].state, 'closed');
  assert.equal(s.gh.state.issues[0].state_reason, 'completed');
  assert.match(s.gh.state.issues[0].comments[0], /Rozjazd ustał/);
  const idle = await s.run(['issue']);
  assert.equal(idle.code, 0);
  assert.match(idle.out, /zgłoszenie bez zmian/);
});

test('issue: cudze zgłoszenie ze znacznikiem (inny autor, PR, brak etykiet) jest ignorowane, zakładane jest własne', async () => {
  const body = `${core.MARKER}\ncudze`;
  const foreign = [
    { ...BOT_ISSUE(1, body), user: { login: 'ktos' } },
    { ...BOT_ISSUE(2, body), pull_request: {} },
    { ...BOT_ISSUE(3, body), labels: [] },
  ];
  const s = setup({ ...DRIFTED, issues: foreign });
  const { out } = await s.run(['issue']);
  assert.match(out, /założono zgłoszenie 101/);
  assert.equal(s.gh.state.issues.length, 4);
  assert.deepEqual(foreign.map((issue) => issue.body), [body, body, body]);
  assert.equal(s.gh.state.issues.slice(0, 3).every((issue) => issue.state === 'open' && !issue.comments), true);
});

test('issue: dwa otwarte zgłoszenia automatu to anomalia: prowadzone najstarsze, kod 1 także bez rozjazdu w treści', async () => {
  const s = setup({ ...DRIFTED, issues: [BOT_ISSUE(9, `${core.MARKER}\nb`), BOT_ISSUE(4, `${core.MARKER}\na`)] });
  const { code, out } = await s.run(['issue']);
  assert.equal(code, 1);
  assert.match(out, /anomalia: otwartych zgłoszeń rozjazdu jest 2, prowadzone jest najstarsze \(4\)/);
  assert.ok(s.gh.state.issues.find((issue) => issue.number === 4).body.includes('Rozbieżności'));
  assert.equal(s.gh.state.issues.find((issue) => issue.number === 9).body, `${core.MARKER}\nb`);
  const clean = setup({ issues: [BOT_ISSUE(9, `${core.MARKER}\nb`), BOT_ISSUE(4, `${core.MARKER}\na`)] });
  const closed = await clean.run(['issue']);
  assert.equal(closed.code, 1);
  assert.deepEqual(clean.gh.state.issues.map((issue) => issue.state), ['closed', 'closed']);
});

test('issue: błąd kontroli (sieć wzorca) nie zmienia ani nie zamyka zgłoszenia, kod 2', async () => {
  const existing = BOT_ISSUE(4, `${core.MARKER}\na`);
  const s = setup({ releases: {}, issues: [existing] });
  const { code } = await s.run(['issue']);
  assert.equal(code, 2);
  assert.equal(s.gh.state.issues[0].state, 'open');
  assert.equal(s.gh.log.some((line) => /^(POST|PATCH)/.test(line)), false);
});

test('issue: zapytanie o zgłoszenia jest zawężone etykietami, stan otwarty, strony po 100', async () => {
  const s = setup();
  await s.run(['issue']);
  assert.ok(s.gh.log.includes('GETALL repos/o/r/issues?state=open&labels=P3,T1,area%3Aprocess,by%3Aagent&per_page=100'));
});

test('pr: baza przesunięta w trakcie biegu: wynik nie jest zapisany, zostaje pending z komunikatem', async () => {
  const MOVED = h.fakeSha('base-moved');
  const s = setup({
    prs: { 1: pr(HEAD) },
    hooks: { onGet: (path, state) => { if (path.includes('/contents/')) state.baseTip = MOVED; } },
  });
  const { code, out } = await s.run(['pr'], { PR_NUMBER: '1' });
  assert.equal(code, 0);
  assert.deepEqual(s.gh.statuses.map((status) => status.state), ['pending']);
  assert.ok(out.startsWith(`## standard-drift PR 1\n- baza przesunęła się w trakcie biegu (${short(f.BASE_SHA)}): wynik nie zapisany`));
  assert.ok(s.gh.log.includes('GET repos/o/r/git/ref/heads/main'));
});

test('pr: baza bez zmian: wynik zapisany (sprawdzenie aktualności czyta czubek domyślnej gałęzi)', async () => {
  const s = setup({ prs: { 1: pr(HEAD) } });
  await s.run(['pr'], { PR_NUMBER: '1' });
  assert.deepEqual(s.gh.statuses.map((status) => status.state), ['pending', 'success']);
  assert.ok(s.gh.log.includes('GET repos/o/r/git/ref/heads/main'));
});

test('push: baza przesunięta w trakcie przeliczania: PR zostaje pending, nowszy bieg rozstrzyga', async () => {
  const s = setup({ prs: heads(1), hooks: { onGet: (path, state) => { if (path === 'repos/o/r/pulls/1') state.baseTip = h.fakeSha('nowsza-baza'); } } });
  await s.run(['push']);
  assert.deepEqual(s.gh.statuses.map((status) => status.state), ['pending']);
});
