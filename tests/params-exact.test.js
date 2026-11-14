'use strict';
// Testy walidatora parametrów z dokładnymi komunikatami i granicami (zabijanie mutantów, kontrola Strykera).
// Każdy przypadek sprawdza całą listę błędów (deepEqual), nie samo "są błędy".

const test = require('node:test');
const assert = require('node:assert/strict');
const params = require('../.github/standard/common/params');

const SHA = 'a'.repeat(40);
const ISSUE = `owner/repo${'#'}12`;
const base = () => ({
  schema: 1,
  standard: { version: 'v1.0.0', sha: SHA },
  audit: { active_since: '' },
  triage: { active_since: '2026-11-11T08:00:00Z' },
  quality_gate: {
    workflow: 'ci.yml',
    jobs: ['tests', 'privacy'],
    required: { pull_request: ['tests'], push: [], workflow_dispatch: ['privacy'] },
  },
  review_gate: { protected_paths: ['a/b', 'c'] },
  overrides: [],
});
const errorsFor = (change) => {
  const value = base();
  change(value);
  return params.validate(value);
};
const override = (extra = {}) => ({ path: 'a/open.yml', reason: 'powod', until: '2026-12-01', issue: ISSUE, ...extra });
const overridesErrors = (list) => errorsFor((value) => { value.overrides = list; });

test('poprawny plik bazowy daje pustą listę', () => {
  assert.deepEqual(params.validate(base()), []);
});

test('korzeń: nie-obiekt, brakujące i nieznane klucze, schema', () => {
  for (const value of [null, [], 'x', 1, undefined, true]) {
    assert.deepEqual(params.validate(value), ['plik parametrów: oczekiwano obiektu JSON']);
  }
  assert.deepEqual(params.validate({}), ['schema', 'standard', 'audit', 'triage', 'quality_gate', 'review_gate', 'overrides'].map((key) => `brak klucza '${key}'`));
  assert.deepEqual(errorsFor((value) => { value.zzz = 1; }), ["nieznany klucz 'zzz'"]);
  assert.deepEqual(errorsFor((value) => { value.zzz = 1; delete value.overrides; }), ["nieznany klucz 'zzz'", "brak klucza 'overrides'"]);
  assert.deepEqual(errorsFor((value) => { value.schema = 2; }), ['schema: oczekiwano 1, jest 2']);
  assert.deepEqual(errorsFor((value) => { value.schema = '1'; }), ['schema: oczekiwano 1, jest "1"']);
  assert.deepEqual(errorsFor((value) => { delete value.schema; }), ["brak klucza 'schema'"]);
  for (const key of ['standard', 'audit', 'triage', 'quality_gate', 'review_gate', 'overrides']) {
    assert.deepEqual(errorsFor((value) => { delete value[key]; }), [`brak klucza '${key}'`], key);
  }
});

test('standard: obiekt, klucze, wersja i SHA', () => {
  for (const value of ['x', null, [], 5]) {
    assert.deepEqual(errorsFor((v) => { v.standard = value; }), ['standard: oczekiwano obiektu']);
  }
  assert.deepEqual(errorsFor((v) => { v.standard = {}; }), ["standard: brak klucza 'version'", "standard: brak klucza 'sha'"]);
  assert.deepEqual(errorsFor((v) => { v.standard = { version: 'v1.0.0', sha: SHA, z: 1 }; }), ["standard: nieznany klucz 'z'"]);
  assert.deepEqual(errorsFor((v) => { v.standard = { version: 'zle', sha: 'zle', z: 1 }; }), ["standard: nieznany klucz 'z'"], 'błędy kluczy kończą walidację obiektu');
  assert.deepEqual(errorsFor((v) => { v.standard = { version: 'zle' }; }), ["standard: brak klucza 'sha'"]);
  assert.deepEqual(errorsFor((v) => { v.standard.version = 'v1'; }), ['standard.version: oczekiwano postaci v1.2.3, jest "v1"']);
  assert.deepEqual(errorsFor((v) => { v.standard.version = 5; }), ['standard.version: oczekiwano postaci v1.2.3, jest 5']);
  const shaMessage = 'standard.sha: oczekiwano pełnego SHA (40 znaków hex, małe litery)';
  for (const sha of [[SHA], 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 5, null, '', ` ${'a'.repeat(40)}`, `${'a'.repeat(40)} `, `g${'a'.repeat(39)}`]) {
    assert.deepEqual(errorsFor((v) => { v.standard.sha = sha; }), [shaMessage], String(sha));
  }
  assert.deepEqual(errorsFor((v) => { v.standard = { version: 'zle', sha: 'zle' }; }), ['standard.version: oczekiwano postaci v1.2.3, jest "zle"', shaMessage]);
  assert.deepEqual(errorsFor((v) => { v.standard.sha = '0123456789abcdef'.repeat(2) + '01234567'; }), []);
});

test('parseVersion: poprawne i niepoprawne wersje', () => {
  assert.deepEqual(params.parseVersion('v0.0.0'), [0, 0, 0]);
  assert.deepEqual(params.parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(params.parseVersion('v10.20.30'), [10, 20, 30]);
  assert.deepEqual(params.parseVersion('v100.200.300'), [100, 200, 300]);
  for (const bad of ['1.2.3', 'xv1.2.3', 'v1.2.3x', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2', 'v1.2.3.4', 'v1x.2.3', 'v1.2x.3', 'v1.2.3\n', 'V1.2.3', '', 123, null, undefined, ['v1.2.3']]) {
    assert.equal(params.parseVersion(bad), null, String(bad));
  }
});

test('FULL_SHA: tylko 40 małych znaków hex w całości napisu', () => {
  assert.equal(params.FULL_SHA.test('0123456789abcdef0123456789abcdef01234567'), true);
  for (const bad of [`x${SHA}`, `${SHA}x`, `${SHA}\n`, SHA.slice(1), `${SHA}a`, 'A'.repeat(40)]) assert.equal(params.FULL_SHA.test(bad), false, bad);
});

test('audit i triage: aktywacja', () => {
  for (const name of ['audit', 'triage']) {
    const set = (change) => errorsFor((value) => { value[name] = change; });
    assert.deepEqual(set('x'), [`${name}: oczekiwano obiektu`]);
    assert.deepEqual(set(null), [`${name}: oczekiwano obiektu`]);
    assert.deepEqual(set({}), [`${name}: brak klucza 'active_since'`]);
    assert.deepEqual(set({ active_since: '', z: 1 }), [`${name}: nieznany klucz 'z'`]);
    assert.deepEqual(set({ active_since: 'zle', z: 1 }), [`${name}: nieznany klucz 'z'`], 'błędy kluczy kończą walidację obiektu');
    for (const good of ['', '2026-11-11T08:00:00Z', '2024-02-29T23:59:59Z', '2026-12-31T00:00:00Z', '2026-01-01T08:09:07Z']) {
      assert.deepEqual(set({ active_since: good }), [], good);
    }
    const bad = ['2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
      '2026-11-11T24:00:00Z', '2026-11-11T00:60:00Z', '2026-11-11T00:00:60Z', '2026-11-32T00:00:00Z', '2026-11-00T00:00:00Z',
      '2026-11-11T08:00:00', 'x2026-11-11T08:00:00Z', '2026-11-11T08:00:00Zx', '2026-11-11T08:00:00+01:00', ' 2026-11-11T08:00:00Z',
      '2026-11-11 08:00:00Z', '2026-1-1T08:00:00Z', 'RRRR-MM-DDTGG:MM:SSZ', '2026-11-11'];
    for (const value of bad) {
      assert.deepEqual(set({ active_since: value }), [`${name}.active_since: oczekiwano RRRR-MM-DDTGG:MM:SSZ (UTC) albo pustego napisu, jest ${JSON.stringify(value)}`], value);
    }
    for (const value of [5, null, false, {}]) {
      assert.deepEqual(set({ active_since: value }), [`${name}.active_since: oczekiwano RRRR-MM-DDTGG:MM:SSZ (UTC) albo pustego napisu, jest ${JSON.stringify(value)}`]);
    }
  }
});

test('validInstant i dateMs: kalendarz, granice i kształt', () => {
  assert.equal(params.validInstant('2026-11-11T08:00:00Z'), true);
  assert.equal(params.validInstant('2024-02-29T00:00:00Z'), true);
  assert.equal(params.validInstant('2025-02-29T00:00:00Z'), false);
  assert.equal(params.validInstant('2026-11-11'), false);
  assert.equal(params.validInstant(undefined), false);
  assert.equal(params.validInstant(5), false);
  for (const exotic of [['2026-11-11T08:00:00Z'], Object.create(null), { toString: () => '2026-11-11T08:00:00Z' }]) {
    assert.equal(params.validInstant(exotic), false, 'obiekt nie jest napisem');
    assert.equal(params.dateMs(exotic), null);
  }
  assert.equal(params.dateMs(['2026-12-01']), null, 'tablica z napisem daty nie jest datą');
  assert.equal(params.dateMs('2026-12-01'), Date.UTC(2026, 11, 1));
  assert.equal(params.dateMs('2024-02-29'), Date.UTC(2024, 1, 29));
  assert.equal(params.dateMs('2000-01-31'), Date.UTC(2000, 0, 31));
  for (const bad of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-01-32', '2026-12-01T00:00:00Z', 'x2026-12-01', '2026-12-01x', '2026-1-1', 'jutro', 5, null, undefined]) {
    assert.equal(params.dateMs(bad), null, String(bad));
  }
});

test('quality_gate: obiekt, klucze, workflow, jobs', () => {
  const set = (change) => errorsFor((value) => { value.quality_gate = change; });
  assert.deepEqual(set('x'), ['quality_gate: oczekiwano obiektu']);
  assert.deepEqual(set({}), ["quality_gate: brak klucza 'workflow'", "quality_gate: brak klucza 'jobs'", "quality_gate: brak klucza 'required'"]);
  const ok = () => base().quality_gate;
  assert.deepEqual(set({ ...ok(), z: 1 }), ["quality_gate: nieznany klucz 'z'"]);
  assert.deepEqual(set({ ...ok(), z: 1, workflow: 5, jobs: [] }), ["quality_gate: nieznany klucz 'z'"], 'błędy kluczy kończą walidację obiektu');
  const workflowMessage = 'quality_gate.workflow: oczekiwano nazwy pliku .yml/.yaml';
  for (const good of ['ci.yml', 'a-b_c.1.yaml', 'X.yml']) assert.deepEqual(set({ ...ok(), workflow: good }), [], good);
  for (const bad of [['ci.yml'], 'ci.yml.bak', 'dir/ci.yml', '../ci.yml', 'ci.txt', '', 5, null, '.yml', 'ci.yaml ', ' ci.yml', 'ci yml']) {
    assert.deepEqual(set({ ...ok(), workflow: bad }), [workflowMessage], String(bad));
  }
  const jobsMessage = 'quality_gate.jobs: oczekiwano niepustej listy unikalnych nazw jobów';
  for (const jobs of [[], ['a', 'a'], [''], [1], 'x', null, ['a', 1], undefined]) {
    assert.deepEqual(set({ ...ok(), jobs, required: 'nie-obiekt' }), [jobsMessage], `${JSON.stringify(jobs)}: błędny jobs kończy walidację przed required`);
  }
  assert.deepEqual(set({ ...ok(), workflow: 5, jobs: [] }), [workflowMessage, jobsMessage]);
  assert.deepEqual(set({ ...ok(), workflow: 5, jobs: ['tests'], required: { pull_request: ['tests'], push: [], workflow_dispatch: [] } }), [workflowMessage]);
});

test('quality_gate.required: obiekt, zdarzenia, unikalność i zgodność z jobs', () => {
  const required = (change) => errorsFor((value) => { value.quality_gate.required = change; });
  const ok = () => base().quality_gate.required;
  assert.deepEqual(required('x'), ['quality_gate.required: oczekiwano obiektu']);
  assert.deepEqual(required(null), ['quality_gate.required: oczekiwano obiektu']);
  assert.deepEqual(required([]), ['quality_gate.required: oczekiwano obiektu']);
  assert.deepEqual(required({ ...ok(), x: [] }), ["quality_gate.required: nieznany klucz 'x'"]);
  assert.deepEqual(required({ ...ok(), x: [], push: 'zle' }), ["quality_gate.required: nieznany klucz 'x'", 'quality_gate.required.push: oczekiwano listy unikalnych nazw jobów'], 'zdarzenia są sprawdzane mimo nieznanego klucza');
  const missing = ok();
  delete missing.push;
  assert.deepEqual(required(missing), ["quality_gate.required: brak klucza 'push'", 'quality_gate.required.push: oczekiwano listy unikalnych nazw jobów']);
  const listMessage = (event) => `quality_gate.required.${event}: oczekiwano listy unikalnych nazw jobów`;
  for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
    for (const names of [['tests', 'tests'], [1], 'x', null, [''], ['tests', 1]]) {
      assert.deepEqual(required({ ...ok(), [event]: names }), [listMessage(event)], `${event} ${JSON.stringify(names)}`);
    }
    assert.deepEqual(required({ ...ok(), [event]: [] }), [], `${event}: pusta lista jest poprawna`);
    assert.deepEqual(required({ ...ok(), [event]: ['tests', 'privacy'] }), [], `${event}: wszystkie z jobs`);
    assert.deepEqual(required({ ...ok(), [event]: ['zzz'] }), [`quality_gate.required.${event}: jobów spoza \`jobs\`: ["zzz"]`]);
    assert.deepEqual(required({ ...ok(), [event]: ['tests', 'zzz', 'qqq'] }), [`quality_gate.required.${event}: jobów spoza \`jobs\`: ["zzz","qqq"]`], 'tylko spoza jobs');
  }
  assert.deepEqual(required({ pull_request: ['x'], push: 'y', workflow_dispatch: ['z'] }), [
    'quality_gate.required.pull_request: jobów spoza `jobs`: ["x"]',
    listMessage('push'),
    'quality_gate.required.workflow_dispatch: jobów spoza `jobs`: ["z"]',
  ]);
});

test('safeRelative: segmenty, znaki sterujące i separatory', () => {
  for (const good of ['a', 'a/b', 'a/b.c', '.github/x', 'a b', 'a~b', 'dir/plik.yml', 'a\u00f3b']) assert.equal(params.safeRelative(good), true, good);
  for (const bad of ['', ' a', 'a ', '/a', 'a/', 'a//b', './a', 'a/./b', 'a/.', '.', '..', 'a/..', '../a', 'a/../b', 'a\\b', 'a:b', 'a\u0001b', 'a\u001fb', 'a\u007fb', 'a\tb', 'a\nb', '\ta', 5, null, undefined, ['a']]) {
    assert.equal(params.safeRelative(bad), false, JSON.stringify(bad));
  }
  assert.equal(params.safeRelative(`a${String.fromCharCode(32)}b`), true, 'spacja (32) w środku jest dozwolona');
  assert.equal(params.safeRelative(`a${String.fromCharCode(31)}b`), false);
  assert.equal(params.safeRelative(`a${String.fromCharCode(127)}b`), false);
  assert.equal(params.safeRelative(`a${String.fromCharCode(126)}b`), true);
  assert.equal(params.safeRelative('..a'), true, 'kropki w nazwie nie są segmentem ..');
  assert.equal(params.safeRelative('a..'), true);
});

test('review_gate: obiekt, klucze i lista ścieżek', () => {
  const set = (change) => errorsFor((value) => { value.review_gate = change; });
  const pathsMessage = 'review_gate.protected_paths: oczekiwano listy bezpiecznych ścieżek względnych';
  assert.deepEqual(set('x'), ['review_gate: oczekiwano obiektu']);
  assert.deepEqual(set({}), ["review_gate: brak klucza 'protected_paths'"]);
  assert.deepEqual(set({ protected_paths: [], z: 1 }), ["review_gate: nieznany klucz 'z'"]);
  assert.deepEqual(set({ protected_paths: 'zle', z: 1 }), ["review_gate: nieznany klucz 'z'"], 'błędy kluczy kończą walidację obiektu');
  assert.deepEqual(set({ protected_paths: [] }), []);
  for (const bad of ['x', null, {}, 5, ['a', '../b'], ['/a'], [''], ['a', 5]]) assert.deepEqual(set({ protected_paths: bad }), [pathsMessage], JSON.stringify(bad));
});

test('isStringList, isObject, has i ParamsError', () => {
  assert.equal(params.isStringList([]), true);
  assert.equal(params.isStringList(['a', 'b']), true);
  for (const bad of [[''], [1], ['a', ''], ['a', 1], 'a', null, undefined, {}, [null]]) assert.equal(params.isStringList(bad), false, JSON.stringify(bad));
  assert.equal(params.isObject({}), true);
  assert.equal(params.isObject({ a: 1 }), true);
  for (const bad of [null, [], 'x', 1, undefined, true]) assert.equal(params.isObject(bad), false, String(bad));
  assert.equal(params.has({ a: 1 }, 'a'), true);
  assert.equal(params.has({}, 'toString'), false);
  assert.equal(params.has({ a: undefined }, 'a'), true);
  const error = new params.ParamsError(['a', 'b']);
  assert.equal(error.message, 'a; b');
  assert.equal(error.name, 'ParamsError');
  assert.deepEqual(error.errors, ['a', 'b']);
  assert.ok(error instanceof Error);
});

test('overrides: lista, wpisy, pola i duplikaty', () => {
  for (const bad of ['x', null, {}, 5]) assert.deepEqual(overridesErrors(bad), ['overrides: oczekiwano listy']);
  assert.deepEqual(overridesErrors([override()]), []);
  assert.deepEqual(overridesErrors([5, null]), ['overrides[0]: oczekiwano obiektu', 'overrides[1]: oczekiwano obiektu'], 'wpisy nie-obiekty nie dają błędu duplikatu');
  assert.deepEqual(overridesErrors([5, 5]), ['overrides[0]: oczekiwano obiektu', 'overrides[1]: oczekiwano obiektu']);
  assert.deepEqual(overridesErrors([override(), { ...override(), path: 'b' }, 5]), ['overrides[2]: oczekiwano obiektu']);
  assert.deepEqual(overridesErrors([{}]), ["overrides[0]: brak klucza 'path'", "overrides[0]: brak klucza 'reason'", "overrides[0]: brak klucza 'until'", "overrides[0]: brak klucza 'issue'"]);
  assert.deepEqual(overridesErrors([override({ extra: 1 })]), ["overrides[0]: nieznany klucz 'extra'"]);
  assert.deepEqual(overridesErrors([override({ extra: 1, path: '../x', reason: '' })]), ["overrides[0]: nieznany klucz 'extra'"], 'błędy kluczy kończą walidację wpisu');
  assert.deepEqual(overridesErrors([override(), override({ path: 'zle//x' })]), ['overrides[1].path: oczekiwano bezpiecznej ścieżki względnej']);
  const reason = (value) => overridesErrors([override({ reason: value })]);
  for (const bad of ['', '   ', '\t\n', 5, null]) assert.deepEqual(reason(bad), ['overrides[0].reason: powód jest wymagany'], JSON.stringify(bad));
  assert.deepEqual(reason(' x '), []);
  assert.deepEqual(overridesErrors([override({ until: '2026-02-30' })]), ['overrides[0].until: oczekiwano istniejącej daty RRRR-MM-DD']);
  assert.deepEqual(overridesErrors([override({ until: 5 })]), ['overrides[0].until: oczekiwano istniejącej daty RRRR-MM-DD']);
  const issueMessage = 'overrides[0].issue: oczekiwano postaci wlasciciel/repo#nr';
  const hash = String.fromCharCode(35);
const withHash = (text) => (typeof text === "string" ? text.replace("§", hash) : text);
  for (const good of ['o/r§1', 'o/r§10', 'a.b-c_d/e.f§123', `Org1/Repo_2§999`]) assert.deepEqual(overridesErrors([override({ issue: withHash(good) })]), [], good);
  assert.deepEqual(overridesErrors([override({ issue: [ISSUE] })]), [issueMessage], 'tablica z napisem zgłoszenia nie jest zgłoszeniem');
  for (const bad of [' o/r§1', 'o/r§1 ', 'o/r§01', 'o/r§0', 'o/r§1x', 'o/r', 'o§1', 'x/o/r§1', 'o/r§', '/r§1', 'o/§1', 5, null, '']) {
    assert.deepEqual(overridesErrors([override({ issue: withHash(bad) })]), [issueMessage], String(bad));
  }
  assert.deepEqual(overridesErrors([override({ path: '../x', reason: '', until: 'zle', issue: 'zle' })]), [
    'overrides[0].path: oczekiwano bezpiecznej ścieżki względnej',
    'overrides[0].reason: powód jest wymagany',
    'overrides[0].until: oczekiwano istniejącej daty RRRR-MM-DD',
    issueMessage,
  ]);
  assert.deepEqual(overridesErrors([override(), override()]), ['overrides: powtórzona ścieżka "a/open.yml"']);
  assert.deepEqual(overridesErrors([override(), override(), override()]), ['overrides: powtórzona ścieżka "a/open.yml"'], 'jedno zgłoszenie na ścieżkę');
  assert.deepEqual(overridesErrors([override({ path: 'b' }), override({ path: 'a' }), override({ path: 'b' }), override({ path: 'a' })]), [
    'overrides: powtórzona ścieżka "a"',
    'overrides: powtórzona ścieżka "b"',
  ], 'posortowane');
  assert.deepEqual(overridesErrors([override({ path: 'a' }), override({ path: 'b' })]), []);
});

const manifest = {
  files: [
    { path: 'a/critical.js', kind: 'exact', critical: true, overridable: true },
    { path: 'a/locked.yml', kind: 'exact', overridable: false },
    { path: 'a/none.yml', kind: 'exact' },
    { path: 'a/open.yml', kind: 'exact', overridable: true },
  ],
};
const TODAY = Date.UTC(2026, 10, 11);
const DAY = 86400000;
const findings = (list) => params.overrideFindings(manifest, list, TODAY);

test('overrideFindings: komunikaty, brzegi dat i notatka niezweryfikowania', () => {
  assert.deepEqual(findings([]), { errors: [], notes: [] });
  assert.deepEqual(findings([override({ path: 'a/other.yml' })]), { errors: ['odstępstwo dla pliku spoza manifestu: a/other.yml'], notes: [] });
  assert.deepEqual(findings([override({ path: 'a/critical.js' })]), { errors: ['odstępstwo dla pliku krytycznego jest niedozwolone: a/critical.js'], notes: [] });
  assert.deepEqual(findings([override({ path: 'a/locked.yml' })]), { errors: ['plik nie dopuszcza odstępstwa: a/locked.yml'], notes: [] });
  assert.deepEqual(findings([override({ path: 'a/none.yml' })]), { errors: ['plik nie dopuszcza odstępstwa: a/none.yml'], notes: [] });
  assert.deepEqual(findings([override({ until: '2026-11-10' })]), { errors: ['odstępstwo wygasło 2026-11-10: a/open.yml'], notes: [] });
  assert.deepEqual(findings([override({ until: '2026-11-11' })]), { errors: [], notes: [`odstępstwo a/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane`] }, 'termin równy dzisiejszej dacie jeszcze nie wygasł');
  assert.deepEqual(findings([override({ until: '2027-02-09' })]), { errors: [], notes: [`odstępstwo a/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane`] }, '90 dni to granica dozwolona');
  assert.equal((Date.UTC(2027, 1, 9) - TODAY) / DAY, 90);
  assert.deepEqual(findings([override({ until: '2027-02-10' })]), { errors: ['odstępstwo z terminem dalszym niż 90 dni: a/open.yml'], notes: [] });
  assert.equal(params.OVERRIDE_MAX_DAYS, 90);
  assert.equal(params.UNVERIFIED_NOTE, 'składnia poprawna, stan zgłoszenia niezweryfikowany');
  assert.deepEqual(findings([override({ path: 'a/other.yml' }), override({ until: '2026-12-01' }), override({ path: 'a/locked.yml' })]), {
    errors: ['odstępstwo dla pliku spoza manifestu: a/other.yml', 'plik nie dopuszcza odstępstwa: a/locked.yml'],
    notes: [`odstępstwo a/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane`],
  });
});

test('validateWithManifest: błędy schematu mają pierwszeństwo, notatki tylko przy poprawnym pliku', () => {
  const broken = { ...base(), schema: 2, overrides: 'nie-lista' };
  assert.deepEqual(params.validateWithManifest(broken, manifest, TODAY), { errors: ['schema: oczekiwano 1, jest 2', 'overrides: oczekiwano listy'], notes: [] });
  assert.deepEqual(params.validateWithManifest(base(), manifest, TODAY), { errors: [], notes: [] });
  const withOverride = { ...base(), overrides: [override()] };
  assert.deepEqual(params.validateWithManifest(withOverride, manifest, TODAY), { errors: [], notes: [`odstępstwo a/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane`] });
  const unknown = { ...base(), overrides: [override({ path: 'a/other.yml' })] };
  assert.deepEqual(params.validateWithManifest(unknown, manifest, TODAY), { errors: ['odstępstwo dla pliku spoza manifestu: a/other.yml'], notes: [] });
});

const parse = params.parseJsonObject;
const syntaxError = (text, message) => assert.throws(() => parse(text), (error) => error instanceof SyntaxError && error.message === message, `${JSON.stringify(text)} -> ${message}`);

test('parseJsonObject: wartości poprawne', () => {
  assert.deepEqual(parse('{}'), {});
  assert.deepEqual(parse(' { } '), {});
  assert.deepEqual(parse('{ "a" : 1 }'), { a: 1 });
  assert.deepEqual(parse('{\t"a"\r\n:\n1\t,\n"b"\t:\t[ ]\r}'), { a: 1, b: [] });
  assert.deepEqual(parse('{"a":{"b":[1,{"c":null}]}}'), { a: { b: [1, { c: null }] } });
  assert.deepEqual(parse('[]'), []);
  assert.deepEqual(parse(' [ ] '), []);
  assert.deepEqual(parse('[1,2]'), [1, 2]);
  assert.deepEqual(parse('\n[ 1 ,\t2 ]\r\n'), [1, 2]);
  assert.equal(parse('true'), true);
  assert.equal(parse('false'), false);
  assert.equal(parse('null'), null);
  assert.equal(parse(' true '), true);
  assert.equal(parse('"x"'), 'x');
  assert.equal(parse('"a\\"b"'), 'a"b');
  assert.equal(parse('"\\\\"'), '\\');
  assert.equal(parse('"\\u0041"'), 'A');
  assert.equal(parse('"zażółć"'), 'zażółć');
  assert.deepEqual(parse('["a\\\\","b"]'), ['a\\', 'b']);
  for (const [text, value] of [['0', 0], ['-1', -1], ['10', 10], ['1.5', 1.5], ['1.50', 1.5], ['1.55', 1.55], ['1e3', 1000], ['1E3', 1000], ['1e+3', 1000], ['1e-3', 0.001], ['-0.5e2', -50], ['12e10', 12e10], ['0.25', 0.25], ['3.14159', 3.14159], ['1e10', 1e10]]) {
    assert.equal(parse(text), value, text);
  }
});

test('parseJsonObject: błędy z dokładnym komunikatem i pozycją', () => {
  syntaxError('{"a":1,"a":2}', 'powtórzony klucz JSON "a" (pozycja 10)');
  syntaxError('{"a" 1}', 'oczekiwano ":" (pozycja 5)');
  syntaxError('{a:1}', 'oczekiwano klucza (pozycja 1)');
  syntaxError('{', 'oczekiwano klucza (pozycja 1)');
  syntaxError('{"a":1 "b":2}', 'oczekiwano "," albo "}" (pozycja 7)');
  syntaxError('{"a":1,}', 'oczekiwano klucza (pozycja 7)');
  syntaxError('[1 2]', 'oczekiwano "," albo "]" (pozycja 3)');
  syntaxError('[1,', 'nieoczekiwany znak (pozycja 3)');
  syntaxError('"abc', 'nieskończony napis (pozycja 4)');
  syntaxError('"abc\\', 'nieskończony napis (pozycja 6)');
  syntaxError('tru', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('nul', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('fals', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('x', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('x1', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('-', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('.5', 'nieoczekiwany znak (pozycja 0)');
  syntaxError('true false', 'dane po końcu dokumentu (pozycja 5)');
  syntaxError('{} x', 'dane po końcu dokumentu (pozycja 3)');
  syntaxError('01', 'dane po końcu dokumentu (pozycja 1)');
  syntaxError('1.', 'dane po końcu dokumentu (pozycja 1)');
  syntaxError('1e', 'dane po końcu dokumentu (pozycja 1)');
  syntaxError('1e+', 'dane po końcu dokumentu (pozycja 1)');
  syntaxError('1.5.5', 'dane po końcu dokumentu (pozycja 3)');
  syntaxError('{"a":1}}', 'dane po końcu dokumentu (pozycja 7)');
  syntaxError('[1]]', 'dane po końcu dokumentu (pozycja 3)');
  syntaxError('{"a":{"b":1,"b":2}}', 'powtórzony klucz JSON "b" (pozycja 15)');
});

test('parseJsonObject: obiekty bez efektów __proto__ i z pełnymi atrybutami własności', () => {
  const parsed = parse('{"__proto__": {"polluted": true}, "a": 1}');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed).sort(), ['__proto__', 'a']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, 'a'), { value: 1, writable: true, enumerable: true, configurable: true });
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, '__proto__').value, { polluted: true });
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
});

test('load: zły JSON, błędy schematu i poprawny plik', () => {
  assert.throws(() => params.load('{'), (error) => error instanceof params.ParamsError && error.name === 'ParamsError' &&
    error.message === 'plik parametrów nie jest poprawnym JSON: oczekiwano klucza (pozycja 1)' &&
    JSON.stringify(error.errors) === JSON.stringify(['plik parametrów nie jest poprawnym JSON: oczekiwano klucza (pozycja 1)']));
  assert.throws(() => params.load('{"schema": 1, "schema": 1}'), (error) => error.errors.length === 1 && /powtórzony klucz JSON "schema"/.test(error.errors[0]));
  const bad = { ...base(), schema: 2, zzz: 1 };
  assert.throws(() => params.load(JSON.stringify(bad)), (error) => error instanceof params.ParamsError &&
    JSON.stringify(error.errors) === JSON.stringify(["nieznany klucz 'zzz'", 'schema: oczekiwano 1, jest 2']) &&
    error.message === "nieznany klucz 'zzz'; schema: oczekiwano 1, jest 2");
  assert.deepEqual(params.load(JSON.stringify(base())), base());
  assert.throws(() => params.load('[]'), (error) => error.message === 'plik parametrów: oczekiwano obiektu JSON');
});
