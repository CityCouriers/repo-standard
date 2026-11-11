'use strict';
// AC-3: walidator pliku parametrów.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const params = require('../.github/standard/common/params');
const { REPO_ROOT } = require('./helpers');

const TODAY = Date.UTC(2026, 10, 11);
const ISSUE = `owner/repo${'#'}12`;

const manifest = {
  files: [
    { path: 'a/critical.js', kind: 'exact', critical: true },
    { path: 'a/locked.yml', kind: 'exact', overridable: false },
    { path: 'a/open.yml', kind: 'exact', overridable: true },
  ],
};

/** Poprawny przykład zbudowany z bloku JSON w README (placeholdery zamienione na poprawne wartości). */
function readmeExample() {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const block = /```json\n([\s\S]*?)```/.exec(readme)[1]
    .replace('<pełny SHA 40 znaków>', 'a'.repeat(40))
    .replace(/RRRR-MM-DDTGG:MM:SSZ/g, '2026-11-11T08:00:00Z')
    .replace('"RRRR-MM-DD"', '"2026-12-01"')
    .replace('owner/repo#nr', ISSUE)
    .replace(/"\.\.\."/g, '"tests"')
    .replace('.github/workflows/x.yml', 'a/open.yml')
    .replace('"reason": "tests"', '"reason": "powod"');
  return JSON.parse(block);
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const withOverride = (override) => ({ ...readmeExample(), overrides: [{ path: 'a/open.yml', reason: 'powod', until: '2026-12-01', issue: ISSUE, ...override }] });

test('akceptuje poprawny plik przykładowy z README', () => {
  const example = readmeExample();
  assert.deepEqual(params.validate(example), []);
  assert.deepEqual(params.load(JSON.stringify(example)), example);
  const result = params.validateWithManifest(example, manifest, TODAY);
  assert.deepEqual(result.errors, []);
});

test('odrzuca złą datę aktywacji i datę spoza kalendarza', () => {
  for (const bad of ['2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-11-11T24:00:00Z', '2026-11-11 08:00:00', '2026-11-11T08:00:00+01:00', 'RRRR-MM-DDTGG:MM:SSZ']) {
    const example = clone(readmeExample());
    example.audit.active_since = bad;
    assert.ok(params.validate(example).length > 0, bad);
  }
  const example = readmeExample();
  example.audit.active_since = '';
  assert.deepEqual(params.validate(example), []);
});

test('odrzuca termin odstępstwa spoza kalendarza', () => {
  for (const until of ['2026-02-30', '2026-13-01', '2026-1-1', 'jutro']) {
    assert.ok(params.validate(withOverride({ until })).length > 0, until);
  }
});

test('odrzuca overrides dla pliku critical, dla overridable: false i dla pliku spoza manifestu', () => {
  const critical = params.validateWithManifest(withOverride({ path: 'a/critical.js' }), manifest, TODAY);
  assert.match(critical.errors.join('\n'), /krytycznego/);
  const locked = params.validateWithManifest(withOverride({ path: 'a/locked.yml' }), manifest, TODAY);
  assert.match(locked.errors.join('\n'), /nie dopuszcza/);
  const unknown = params.validateWithManifest(withOverride({ path: 'a/other.yml' }), manifest, TODAY);
  assert.match(unknown.errors.join('\n'), /spoza manifestu/);
});

test('odrzuca termin dłuższy niż 90 dni i wygasły', () => {
  const far = params.validateWithManifest(withOverride({ until: '2027-03-01' }), manifest, TODAY);
  assert.match(far.errors.join('\n'), /90 dni/);
  const edge = params.validateWithManifest(withOverride({ until: '2027-02-09' }), manifest, TODAY);
  assert.deepEqual(edge.errors, []);
  const expired = params.validateWithManifest(withOverride({ until: '2026-11-10' }), manifest, TODAY);
  assert.match(expired.errors.join('\n'), /wygasło/);
});

test('odrzuca brak numeru zgłoszenia i zły jego kształt', () => {
  for (const issue of ['', 'abc', 'owner/repo', `owner/repo${'#'}0`, `owner/repo${'#'}x`, `${'#'}12`, `owner repo${'#'}12`, 12]) {
    assert.ok(params.validate(withOverride({ issue })).length > 0, String(issue));
  }
  const missing = withOverride({});
  delete missing.overrides[0].issue;
  assert.match(params.validate(missing).join('\n'), /brak klucza 'issue'/);
});

test('odrzuca nieznane pola na każdym poziomie i powtórzone klucze JSON', () => {
  const top = { ...readmeExample(), extra: 1 };
  assert.match(params.validate(top).join('\n'), /nieznany klucz 'extra'/);
  const nested = readmeExample();
  nested.audit.other = 1;
  assert.ok(params.validate(nested).length > 0);
  assert.ok(params.validate(withOverride({ extra: 1 })).length > 0);
  assert.throws(() => params.load('{"schema": 1, "schema": 1}'), params.ParamsError);
  assert.throws(() => params.load('{"schema": 1,}'), params.ParamsError);
  assert.throws(() => params.load('[]'), params.ParamsError);
});

test('poprawny wyjątek daje wynik "stan zgłoszenia niezweryfikowany" i nie jest zatwierdzony', () => {
  const result = params.validateWithManifest(withOverride({}), manifest, TODAY);
  assert.deepEqual(result.errors, []);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /stan zgłoszenia niezweryfikowany/);
  assert.match(result.notes[0], /nie jest uznane/);
  assert.doesNotMatch(result.notes[0], /zatwierdzon/);
});

test('parser JSON nie ulega __proto__', () => {
  const parsed = params.parseJsonObject('{"__proto__": {"polluted": true}}');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(parsed).length, 1);
});
