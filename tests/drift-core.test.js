'use strict';
// Testy czystej logiki kontroli rozjazdu: oczyszczanie, odcisk, status, wczesne wyjście, wybór pinu, zgłoszenie.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../.github/standard/drift/drift_core');
const h = require('./helpers');

const BOT = 'github-actions[bot]';
const label = (name) => ({ name });
const OWN_LABELS = ['P3', 'T1', 'area:process', 'by:agent'].map(label);

function issue(number, body, extra = {}) {
  return { number, state: 'open', user: { login: BOT }, labels: OWN_LABELS, body, ...extra };
}

test('sanitize: znaki sterujące, znaczniki i odwrotne apostrofy znikają, tekst jest przycięty', () => {
  assert.equal(core.sanitize('a\nb\r\nc\u0000d'), 'a b c d');
  assert.equal(core.sanitize('::set-output name=x::y\n::add-mask::z'), '::set-output name=x::y ::add-mask::z');
  assert.equal(core.sanitize('`x` <b>'), "'x' ‹b›");
  assert.equal(core.sanitize('  a   b  '), 'a b');
  assert.equal(core.sanitize('a b\u0085c\u007fd'), 'a b c d');
  assert.equal(core.sanitize('abcdef', 4), 'abc…');
  assert.equal(core.sanitize('abcd', 4), 'abcd');
  assert.equal(core.sanitize(42), '42');
  assert.equal(core.sanitize('x'.repeat(400)).length, 300);
});

test('fingerprint: niezależny od kolejności i powtórzeń, zależny od treści', () => {
  assert.match(core.fingerprint(['a', 'b']), /^[0-9a-f]{64}$/);
  assert.equal(core.fingerprint(['a', 'b']), core.fingerprint(['b', 'a', 'a']));
  assert.notEqual(core.fingerprint(['a', 'b']), core.fingerprint(['a', 'c']));
  assert.notEqual(core.fingerprint(['a']), core.fingerprint([]));
});

test('statusBody: stały kontekst i opis do 140 znaków bez znaków sterujących', () => {
  const body = core.statusBody('failure', `x\n${'y'.repeat(300)}`);
  assert.deepEqual(Object.keys(body), ['state', 'context', 'description']);
  assert.equal(body.state, 'failure');
  assert.equal(body.context, 'standard-drift');
  assert.equal(body.description.length, 140);
  assert.ok(!/[\n\r]/.test(body.description));
});

test('touchesStandard: ścieżka z manifestu, poprzednia nazwa, .github/, limit listy', () => {
  const managed = ['scripts/ci/privacy-scan.sh', 'a/b.js'];
  assert.equal(core.touchesStandard([], managed), false);
  assert.equal(core.touchesStandard([{ filename: 'README.md' }], managed), false);
  assert.equal(core.touchesStandard([{ filename: 'a/b.js' }], managed), true);
  assert.equal(core.touchesStandard([{ filename: 'x.md', previous_filename: 'a/b.js' }], managed), true);
  assert.equal(core.touchesStandard([{ filename: '.github/workflows/z.yml' }], managed), true);
  assert.equal(core.touchesStandard([{ filename: 'x/.github/z.yml' }], managed), false);
  assert.equal(core.touchesStandard([{ filename: '.githubx/z' }], managed), false);
  assert.equal(core.touchesStandard([{ filename: 1 }, {}, { filename: null, previous_filename: undefined }], managed), false);
  const many = Array.from({ length: core.MAX_FILES }, (_, i) => ({ filename: `f${i}` }));
  assert.equal(core.touchesStandard(many, managed), true);
  assert.equal(core.touchesStandard(many.slice(1), managed), false);
});

const BASE = { version: 'v1.0.0', sha: h.fakeSha('a') };
const HEAD = { version: 'v1.1.0', sha: h.fakeSha('b') };

test('choosePin: ten sam pin zostaje bez pytania sieci', async () => {
  const result = await core.choosePin(BASE, { ...BASE }, async () => { throw new Error('nie wolno'); });
  assert.deepEqual(result, { pin: BASE, findings: [], notes: [] });
});

test('choosePin: ta sama wersja, inny SHA, to zmiana pinu do sprawdzenia', async () => {
  const result = await core.choosePin(BASE, { version: BASE.version, sha: HEAD.sha }, async () => BASE.sha);
  assert.equal(result.pin, BASE);
  assert.match(result.findings[0], /SHA nie jest commitem tagu v1\.0\.0/);
  const sameSha = await core.choosePin(BASE, { version: 'v1.1.0', sha: BASE.sha }, async () => BASE.sha);
  assert.equal(sameSha.pin.version, 'v1.1.0');
});

test('choosePin: tag potwierdza SHA, pin z HEAD obowiązuje z notatką', async () => {
  const seen = [];
  const result = await core.choosePin(BASE, HEAD, async (version) => { seen.push(version); return HEAD.sha; });
  assert.deepEqual(seen, ['v1.1.0']);
  assert.equal(result.pin, HEAD);
  assert.deepEqual(result.findings, []);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /PR zmienia wzorzec z v1\.0\.0 na v1\.1\.0/);
});

test('choosePin: tag wskazuje inny SHA albo nie istnieje: pin bazy i różnica', async () => {
  const other = await core.choosePin(BASE, HEAD, async () => BASE.sha);
  assert.equal(other.pin, BASE);
  assert.deepEqual(other.findings, ['standard: zmiana wersji w PR nieuznana, SHA nie jest commitem tagu v1.1.0']);
  assert.deepEqual(other.notes, []);
  const missing = await core.choosePin(BASE, HEAD, async () => { throw new Error('brak\ntagu'); });
  assert.equal(missing.pin, BASE);
  assert.deepEqual(missing.findings, ['standard: zmiana wersji w PR nieuznana, nie rozpoznano tagu v1.1.0: brak tagu']);
  assert.deepEqual(missing.notes, []);
});

test('ownIssues: tylko otwarte zgłoszenia bota ze znacznikiem w pierwszej linii i wszystkimi etykietami, najstarsze pierwsze', () => {
  const ok = (n) => issue(n, `${core.MARKER}\nx`);
  const list = [
    ok(9),
    ok(3),
    issue(4, `${core.MARKER}\nx`, { user: { login: 'ktos' } }),
    issue(5, `${core.MARKER}\nx`, { pull_request: {} }),
    issue(6, `${core.MARKER}\nx`, { state: 'closed' }),
    issue(7, `x\n${core.MARKER}`),
    issue(8, `${core.MARKER}x`),
    issue(10, `${core.MARKER}\nx`, { labels: OWN_LABELS.slice(1) }),
    issue(11, `${core.MARKER}\nx`, { labels: null }),
    issue(12, null),
    issue(13, `${core.MARKER}\r\nx`),
    issue(14, `${core.MARKER}\nx`, { user: null }),
    issue(15, `${core.MARKER}\nx`, { labels: [null, ...OWN_LABELS] }),
    null,
  ];
  assert.deepEqual(core.ownIssues(list).map((entry) => entry.number), [3, 9, 13, 15]);
});

test('storedFingerprint: tylko druga linia w dokładnej postaci', () => {
  const fp = core.fingerprint(['a']);
  assert.equal(core.storedFingerprint(`${core.MARKER}\n<!-- fingerprint: ${fp} -->\nx`), fp);
  assert.equal(core.storedFingerprint(`${core.MARKER}\r\n<!-- fingerprint: ${fp} -->\r\nx`), fp);
  assert.equal(core.storedFingerprint(`${core.MARKER}`), null);
  assert.equal(core.storedFingerprint(`${core.MARKER}\nx\n<!-- fingerprint: ${fp} -->`), null);
  assert.equal(core.storedFingerprint(`${core.MARKER}\n<!-- fingerprint: ${fp.slice(1)} -->`), null);
  assert.equal(core.storedFingerprint(`${core.MARKER}\n x<!-- fingerprint: ${fp} -->`), null);
});

const DRIFT = { repo: 'o/r', version: 'v1.0.0', findings: ['b: rozjazd', 'a: brak pliku', 'a: brak pliku'] };

test('renderIssue: znacznik, odcisk, lista bez powtórzeń w bloku, polecenie naprawy i odsyłacz', () => {
  const { title, body, labels } = core.renderIssue(DRIFT);
  assert.equal(title, 'Rozjazd wzorca');
  assert.deepEqual(labels, ['P3', 'T1', 'area:process', 'by:agent']);
  const lines = body.split('\n');
  assert.equal(lines[0], core.MARKER);
  assert.equal(lines[1], `<!-- fingerprint: ${core.fingerprint(DRIFT.findings)} -->`);
  assert.ok(body.includes('Repozytorium `o/r`, wzorzec `v1.0.0`. Rozbieżności: 2.'));
  assert.ok(body.includes('```text\na: brak pliku\nb: rozjazd\n```'));
  assert.ok(body.includes('`node .github/standard/standard_sync.js apply --version v1.0.0`'));
  assert.ok(body.includes('https://github.com/CityCouriers/repo-standard#poprawka-z-konsumenta'));
  assert.ok(!body.includes('@'));
});

test('renderIssue: lista skrócona do MAX_LISTED z liczbą pominiętych, złośliwe wiersze oczyszczone', () => {
  const findings = Array.from({ length: core.MAX_LISTED + 3 }, (_, i) => `p${String(i).padStart(3, '0')}: rozjazd`);
  const { body } = core.renderIssue({ ...DRIFT, findings });
  assert.ok(body.includes('p049: rozjazd'));
  assert.ok(!body.includes('p050: rozjazd'));
  assert.ok(body.includes('... i 3 kolejnych'));
  const evil = core.renderIssue({ ...DRIFT, findings: ['```\n@ktos <script> `x`'] }).body;
  assert.ok(!evil.includes('```\n@ktos'));
  assert.ok(!evil.includes('<script>'));
  assert.equal(evil.split('```').length, 3);
});

test('planIssue: brak rozjazdu i brak zgłoszeń: nic; rozjazd bez zgłoszenia: jedno założenie', () => {
  assert.deepEqual(core.planIssue([], null), { anomaly: false, ops: [] });
  const plan = core.planIssue([], DRIFT);
  assert.equal(plan.anomaly, false);
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].type, 'create');
  assert.equal(plan.ops[0].title, 'Rozjazd wzorca');
  assert.deepEqual(plan.ops[0].labels, core.LABELS);
});

test('planIssue: ta sama treść: bez operacji; zmiana listy: aktualizacja i jeden komentarz; zmiana tylko treści bez listy: bez komentarza', () => {
  const rendered = core.renderIssue(DRIFT);
  const same = core.planIssue([issue(5, rendered.body)], DRIFT);
  assert.deepEqual(same, { anomaly: false, ops: [] });
  const changed = { ...DRIFT, findings: ['c: rozjazd'] };
  const plan = core.planIssue([issue(5, rendered.body)], changed);
  assert.deepEqual(plan.ops.map((op) => op.type), ['update', 'comment']);
  assert.equal(plan.ops[0].number, 5);
  assert.equal(plan.ops[0].body, core.renderIssue(changed).body);
  assert.equal(plan.ops[1].number, 5);
  assert.ok(plan.ops[1].comment.includes(core.fingerprint(changed.findings).slice(0, 12)));
  const reworded = issue(5, rendered.body.replace('Naprawa', 'Naprawa (stare)'));
  assert.deepEqual(core.planIssue([reworded], DRIFT).ops.map((op) => op.type), ['update']);
  const unmarked = issue(5, `${core.MARKER}\nbez odcisku`);
  assert.deepEqual(core.planIssue([unmarked], DRIFT).ops.map((op) => op.type), ['update', 'comment']);
});

test('planIssue: anomalia dwóch zgłoszeń prowadzi najstarsze', () => {
  const rendered = core.renderIssue(DRIFT);
  const plan = core.planIssue([issue(2, 'x'), issue(7, rendered.body)], DRIFT);
  assert.equal(plan.anomaly, true);
  assert.equal(plan.ops.every((op) => op.number === 2), true);
  assert.deepEqual(core.planIssue([issue(2, 'x')], DRIFT).anomaly, false);
});

test('planIssue: rozjazd ustał: komentarz i zamknięcie każdego otwartego zgłoszenia', () => {
  const plan = core.planIssue([issue(2, 'x'), issue(7, 'y')], null);
  assert.equal(plan.anomaly, true);
  assert.deepEqual(plan.ops.map((op) => [op.type, op.number]), [['close', 2], ['close', 7]]);
  assert.match(plan.ops[0].comment, /Rozjazd ustał/);
});
