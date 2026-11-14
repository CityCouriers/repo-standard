'use strict';
// Testy jednostkowe standard_sync.js z dokładnymi komunikatami (kontrola Strykera): manifest, bloki, pliki lokalne,
// adresy, rozpoznanie tagu i bezpieczne zapisy. Bez sieci.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const params = require('../.github/standard/common/params');
const sync = require('../.github/standard/standard_sync');
const h = require('./helpers');

const H64 = 'a'.repeat(64);
const SHA = 'c'.repeat(40);
const ISSUE_ID = `o/r${String.fromCharCode(35)}1`;
const TODAY = Date.UTC(2026, 10, 11);
const entry = (extra = {}) => ({ path: 'a/x.js', kind: 'exact', sha256: H64, ...extra });
const manifestOf = (files, extra = {}) => ({ schema: 1, version: 'v1.0.0', files, ...extra });
const errs = (files, extra) => sync.manifestErrors(manifestOf(files, extra));
const PATH_MSG = (i = 0) => `files[${i}].path: oczekiwano bezpiecznej ścieżki względnej`;

test('manifestErrors: poprawny manifest, korzeń, schemat, wersja, lista plików', () => {
  const good = [entry(), { path: 'b.txt', kind: 'block', block: 'blk-1', sha256: H64, skeleton: '# s\n' }, { path: 's.txt', kind: 'seed', sha256: H64, markers: ['m'] }, { path: params.PARAMS_PATH, kind: 'param' }];
  assert.deepEqual(errs(good), []);
  for (const bad of [null, [], 'x', 5, undefined]) assert.deepEqual(sync.manifestErrors(bad), ['manifest: oczekiwano obiektu']);
  assert.deepEqual(sync.manifestErrors({}), ['manifest.schema: oczekiwano 1', 'manifest.version: oczekiwano postaci v1.2.3', 'manifest.files: oczekiwano niepustej listy']);
  assert.deepEqual(errs(good, { z: 1 }), ["manifest: nieznany klucz 'z'"]);
  assert.deepEqual(errs(good, { schema: 2 }), ['manifest.schema: oczekiwano 1']);
  assert.deepEqual(errs(good, { version: 'v1' }), ['manifest.version: oczekiwano postaci v1.2.3']);
  assert.deepEqual(errs(good, { version: 5 }), ['manifest.version: oczekiwano postaci v1.2.3']);
  for (const files of [[], 'x', null, {}]) {
    assert.deepEqual(errs(files), ['manifest.files: oczekiwano niepustej listy']);
    assert.deepEqual(errs(files, { z: 1, schema: 2 }), ["manifest: nieznany klucz 'z'", 'manifest.schema: oczekiwano 1', 'manifest.files: oczekiwano niepustej listy'], 'błąd listy kończy walidację przed wpisami');
  }
});

test('manifestErrors: duplikaty ścieżek i wpisy nie-obiekty', () => {
  assert.deepEqual(errs([entry(), entry()]), ['manifest: powtórzona ścieżka "a/x.js"']);
  assert.deepEqual(errs([entry(), entry(), entry()]), ['manifest: powtórzona ścieżka "a/x.js"']);
  assert.deepEqual(errs([entry({ path: 'b' }), entry({ path: 'a' }), entry({ path: 'b' }), entry({ path: 'a' })]), ['manifest: powtórzona ścieżka "a"', 'manifest: powtórzona ścieżka "b"']);
  assert.deepEqual(errs([entry({ path: 'a' }), entry({ path: 'b' })]), []);
  assert.deepEqual(errs([5, 5]), ['files[0]: oczekiwano obiektu', 'files[1]: oczekiwano obiektu']);
  assert.deepEqual(errs([null, []]), ['files[0]: oczekiwano obiektu', 'files[1]: oczekiwano obiektu']);
  assert.deepEqual(errs([entry({ path: 5 }), entry({ path: 5 })]), [PATH_MSG(0), PATH_MSG(1)], 'ścieżki nie-napisy nie liczą się jako duplikaty');
  assert.deepEqual(errs([entry({ path: undefined }), entry({ path: undefined })]), [PATH_MSG(0), PATH_MSG(1)]);
});

test('manifestErrors: ścieżka, source, rodzaj i flagi wpisu', () => {
  assert.deepEqual(errs([entry({ z: 1 })]), ["files[0]: nieznany klucz 'z'"]);
  assert.deepEqual(errs([entry({ z: 1, y: 2 })]), ["files[0]: nieznany klucz 'z'", "files[0]: nieznany klucz 'y'"]);
  for (const bad of ['../x', 'a/../x', '.git/x', '.GIT/x', 'a/.Git/x', 'a/git~1/x', 'GIT~12/x', '.git', '/abs', 'a\\b', 'a:b', '', ' a', 'a//b']) {
    assert.deepEqual(errs([entry({ path: bad })]), [PATH_MSG()], JSON.stringify(bad));
  }
  for (const ok of ['.github/x', '.gitignore', 'a.git', 'x.git/y', 'xgit~1', 'git~', 'git~1x', 'a/gitx/y', '.gitx/y', 'git/x']) {
    assert.deepEqual(errs([entry({ path: ok })]), [], ok);
  }
  assert.deepEqual(errs([entry({ source: '../x' })]), ['files[0].source: oczekiwano bezpiecznej ścieżki względnej']);
  assert.deepEqual(errs([entry({ source: '.git/x' })]), ['files[0].source: oczekiwano bezpiecznej ścieżki względnej']);
  assert.deepEqual(errs([entry({ source: 't/x' })]), []);
  assert.deepEqual(errs([entry({ path: '../x', source: '../y' })]), [PATH_MSG(), 'files[0].source: oczekiwano bezpiecznej ścieżki względnej']);
  const kindMessage = 'files[0].kind: oczekiwano jednego z exact, block, seed, param';
  for (const kind of ['zly', undefined, 5, null, ['exact'], 'EXACT']) assert.deepEqual(errs([entry({ kind })]), [kindMessage], String(kind));
  assert.deepEqual(errs([entry({ kind: 'zly', path: '../x', z: 1 })]), ["files[0]: nieznany klucz 'z'", PATH_MSG(), kindMessage], 'przy złym rodzaju kończy się po błędach ścieżki');
  assert.deepEqual(errs([entry({ critical: 'tak' })]), ['files[0].critical: oczekiwano true/false']);
  assert.deepEqual(errs([entry({ overridable: 1 })]), ['files[0].overridable: oczekiwano true/false']);
  assert.deepEqual(errs([entry({ critical: 'tak', overridable: 1 })]), ['files[0].critical: oczekiwano true/false', 'files[0].overridable: oczekiwano true/false', 'files[0]: plik krytyczny musi być exact i bez odstępstwa']);
  assert.deepEqual(errs([entry({ critical: false, overridable: true })]), []);
  assert.deepEqual(errs([entry({ critical: true })]), []);
});

test('manifestErrors: rodzaj param', () => {
  assert.deepEqual(errs([{ path: params.PARAMS_PATH, kind: 'param' }]), []);
  assert.deepEqual(errs([{ path: 'inne.json', kind: 'param' }]), [`files[0]: plik param to ${params.PARAMS_PATH}`]);
  for (const key of ['sha256', 'block', 'markers', 'skeleton']) {
    assert.deepEqual(errs([{ path: params.PARAMS_PATH, kind: 'param', [key]: 'x' }]), [`files[0]: pole '${key}' nie dotyczy rodzaju param`], key);
  }
  assert.deepEqual(errs([{ path: 'inne.json', kind: 'param', sha256: 'x', block: 'x' }]), [
    `files[0]: plik param to ${params.PARAMS_PATH}`,
    "files[0]: pole 'sha256' nie dotyczy rodzaju param",
    "files[0]: pole 'block' nie dotyczy rodzaju param",
  ], 'param kończy walidację bez sprawdzania sumy');
});

test('manifestErrors: suma, blok, szkielet, markery i plik krytyczny', () => {
  const shaMessage = 'files[0].sha256: oczekiwano 64 znaków hex';
  for (const bad of [undefined, 5, 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `x${H64}`, `${H64}x`, `${H64}\n`, '', [H64], null]) {
    assert.deepEqual(errs([entry({ sha256: bad })]), [shaMessage], JSON.stringify(bad));
  }
  const block = (extra = {}) => ({ path: 'b.txt', kind: 'block', block: 'blk-1', sha256: H64, ...extra });
  const blockMessage = 'files[0].block: oczekiwano identyfikatora [a-z0-9-]+';
  assert.deepEqual(errs([block()]), []);
  assert.deepEqual(errs([block({ block: 'a0-9' })]), []);
  for (const bad of [undefined, 5, '', 'A', 'a_b', 'a b', 'a.b', '.ab', 'ab.', ' ab', 'ab ', ['abc'], null]) {
    assert.deepEqual(errs([block({ block: bad })]), [blockMessage], JSON.stringify(bad));
  }
  assert.deepEqual(errs([block({ skeleton: '' })]), []);
  assert.deepEqual(errs([block({ skeleton: 5 })]), ['files[0].skeleton: oczekiwano napisu']);
  assert.deepEqual(errs([block({ skeleton: null })]), ['files[0].skeleton: oczekiwano napisu']);
  const onlyBlock = 'files[0]: pola block i skeleton dotyczą tylko rodzaju block';
  assert.deepEqual(errs([entry({ block: 'x' })]), [onlyBlock]);
  assert.deepEqual(errs([entry({ skeleton: 'x' })]), [onlyBlock]);
  assert.deepEqual(errs([entry({ block: 'x', skeleton: 'y' })]), [onlyBlock]);
  assert.deepEqual(errs([{ path: 's.txt', kind: 'seed', sha256: H64, markers: ['m'], block: 'x' }]), [onlyBlock]);
  const seed = (extra = {}) => ({ path: 's.txt', kind: 'seed', sha256: H64, markers: ['m'], ...extra });
  const markersMessage = 'files[0].markers: oczekiwano niepustej listy napisów';
  assert.deepEqual(errs([seed()]), []);
  assert.deepEqual(errs([seed({ markers: ['a', 'b'] })]), []);
  for (const bad of [undefined, [], [''], 'x', [1], ['a', ''], null]) assert.deepEqual(errs([seed({ markers: bad })]), [markersMessage], JSON.stringify(bad));
  assert.deepEqual(errs([entry({ markers: ['m'] })]), ['files[0].markers: dotyczy tylko rodzaju seed']);
  assert.deepEqual(errs([block({ markers: ['m'] })]), ['files[0].markers: dotyczy tylko rodzaju seed']);
  const criticalMessage = 'files[0]: plik krytyczny musi być exact i bez odstępstwa';
  assert.deepEqual(errs([entry({ critical: true })]), []);
  assert.deepEqual(errs([entry({ critical: true, overridable: false })]), []);
  assert.deepEqual(errs([entry({ critical: true, overridable: true })]), [criticalMessage]);
  assert.deepEqual(errs([block({ critical: true })]), [criticalMessage]);
  assert.deepEqual(errs([seed({ critical: true })]), [criticalMessage]);
  assert.deepEqual(errs([block({ critical: false })]), []);
  assert.deepEqual(errs([entry({ critical: false, overridable: true })]), []);
  assert.deepEqual(errs([entry({ sha256: 'zle', critical: 'x' })]), ['files[0].critical: oczekiwano true/false', shaMessage]);
});

test('parseManifest: JSON, schemat i poprawny manifest; SyncError ma nazwę', () => {
  assert.throws(() => sync.parseManifest('{'), (error) => error instanceof sync.SyncError && error.name === 'SyncError' && error.message === 'manifest nie jest poprawnym JSON: oczekiwano klucza (pozycja 1)');
  assert.throws(() => sync.parseManifest('{"schema":2,"zzz":1}'), (error) => error instanceof sync.SyncError && error.message === "manifest niepoprawny: manifest: nieznany klucz 'zzz'; manifest.schema: oczekiwano 1; manifest.version: oczekiwano postaci v1.2.3; manifest.files: oczekiwano niepustej listy");
  const good = manifestOf([entry()]);
  assert.deepEqual(sync.parseManifest(JSON.stringify(good)), good);
  assert.equal(new sync.SyncError('x').name, 'SyncError');
});

const BEGIN = '# repo-standard:begin ';
const END = '# repo-standard:end ';

test('blockOf: zawartość bloku, obcinanie znaczników, liczność i kolejność', () => {
  const text = `a\n${BEGIN}x\nl1\nl2\n${END}x\nz\n`;
  assert.equal(sync.blockOf(text, 'x'), 'l1\nl2\n');
  assert.equal(sync.blockOf(`${BEGIN}x\n${END}x`, 'x'), '', 'pusty blok');
  assert.equal(sync.blockOf(`  ${BEGIN}x  \nl1\n\t${END}x\t\n`, 'x'), 'l1\n', 'znaczniki z białymi znakami');
  assert.equal(sync.blockOf(`${BEGIN}x\r\nl1\r\n${END}x\r\n`, 'x'), 'l1\r\n', 'CRLF: znaczniki rozpoznane, treść zachowana');
  assert.equal(sync.blockOf(`${BEGIN}x\nl1\n${END}x\n${BEGIN}xy\nl2\n${END}xy\n`, 'x'), 'l1\n', 'inny identyfikator nie jest tym blokiem');
  assert.equal(sync.blockOf(`${BEGIN}x\nl1\n${END}x\n${BEGIN}xy\nl2\n${END}xy\n`, 'xy'), 'l2\n');
  assert.equal(sync.blockOf(`${BEGIN}x\nl1\n${END}x\n${BEGIN}x\nl2\n${END}x\n`, 'x'), null, 'dwa bloki o tym samym identyfikatorze');
  assert.equal(sync.blockOf(`${BEGIN}x\n${BEGIN}x\nl\n${END}x\n`, 'x'), null, 'dwa begin');
  assert.equal(sync.blockOf(`${BEGIN}x\nl\n${END}x\n${END}x\n`, 'x'), null, 'dwa end');
  assert.equal(sync.blockOf(`l\n${END}x\n`, 'x'), null, 'brak begin');
  assert.equal(sync.blockOf(`${BEGIN}x\nl\n`, 'x'), null, 'brak end');
  assert.equal(sync.blockOf(`${END}x\nl\n${BEGIN}x\n`, 'x'), null, 'end przed begin');
  assert.equal(sync.blockOf('nic\n', 'x'), null);
  assert.equal(sync.blockOf(`${BEGIN}x extra\nl\n${END}x\n`, 'x'), null, 'znacznik z dopiskiem nie jest znacznikiem');
});

test('replaceBlock: podmiana bloku z zachowaniem reszty pliku', () => {
  assert.equal(sync.replaceBlock('bez znaczników\n', 'x', 'NEW\n'), null);
  assert.equal(sync.replaceBlock(`${BEGIN}x\nl\n`, 'x', 'NEW\n'), null);
  assert.equal(sync.replaceBlock(`a\n${BEGIN}x\nold1\nold2\n${END}x\nz\n`, 'x', 'NEW\n'), `a\n${BEGIN}x\nNEW\n${END}x\nz\n`);
  assert.equal(sync.replaceBlock(`${BEGIN}x\nold\n${END}x`, 'x', 'NEW\n'), `${BEGIN}x\nNEW\n${END}x`, 'bez końcowego znaku nowego wiersza');
  assert.equal(sync.replaceBlock(`${BEGIN}x\n${END}x\n`, 'x', 'NEW\n'), `${BEGIN}x\nNEW\n${END}x\n`, 'pusty blok');
  assert.equal(sync.replaceBlock(`${BEGIN}y\nkeep\n${END}y\n${BEGIN}x\nold\n${END}x\n${BEGIN}xy\nkeep2\n${END}xy\n`, 'x', 'NEW\n'),
    `${BEGIN}y\nkeep\n${END}y\n${BEGIN}x\nNEW\n${END}x\n${BEGIN}xy\nkeep2\n${END}xy\n`, 'tylko wskazany blok');
  assert.equal(sync.replaceBlock(`  ${BEGIN}x  \nold\n  ${END}x\n`, 'x', 'NEW\n'), `  ${BEGIN}x  \nNEW\n  ${END}x\n`, 'znaczniki zachowane z wcięciem');
});

test('textOf, sha256, dumpJson, readPlainFile', (t) => {
  assert.equal(sync.textOf(Buffer.from('zażółć')), 'zażółć');
  assert.equal(sync.textOf(Buffer.from('')), '');
  assert.equal(sync.textOf(Buffer.from([0xff, 0xfe])), null);
  assert.equal(sync.textOf(Buffer.from([0xc3])), null, 'ucięty znak wielobajtowy');
  assert.equal(sync.sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sync.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(Buffer.isBuffer(sync.dumpJson({})));
  assert.equal(sync.dumpJson({ a: [1], b: 'ó' }).toString('utf8'), '{\n  "a": [\n    1\n  ],\n  "b": "ó"\n}\n');
  assert.deepEqual([...sync.dumpJson({ b: 'ó' })], [...Buffer.from('{\n  "b": "ó"\n}\n', 'utf8')]);
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, 'a/f.txt', 'treść');
  fs.mkdirSync(path.join(root, 'dir'));
  assert.equal(sync.readPlainFile(root, 'a/f.txt').toString('utf8'), 'treść');
  assert.equal(sync.readPlainFile(root, 'a/nie-ma.txt'), null);
  assert.equal(sync.readPlainFile(root, 'dir'), null, 'katalog nie jest plikiem');
  if (h.trySymlink(path.join(root, 'a', 'f.txt'), path.join(root, 'link.txt'), 'file')) {
    assert.equal(sync.readPlainFile(root, 'link.txt'), null, 'dowiązanie do pliku nie jest zwykłym plikiem');
  }
});

// ------------------------------------------------------------------ checkSelf / checkConsumer

const plainEntries = (data) => ({
  exact: { path: 'x/exact.js', kind: 'exact', sha256: h.sha256(Buffer.from(data.exact)) },
  block: { path: 'x/block.txt', kind: 'block', block: 'b1', sha256: h.sha256(Buffer.from(data.block)) },
  seed: { path: 'x/seed.txt', kind: 'seed', sha256: h.sha256(Buffer.from(data.seed)), markers: ['M1', 'M2'] },
});

test('checkSelf: pliki exact, block i seed z dokładnymi komunikatami', (t) => {
  const data = { exact: 'E\n', block: 'B\n', seed: 'M1 M2\n' };
  const e = plainEntries(data);
  const manifest = manifestOf([e.exact, e.block, e.seed, { path: params.PARAMS_PATH, kind: 'param' }]);
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY), {
    findings: ['x/exact.js: brak pliku', 'x/block.txt: brak pliku', 'x/seed.txt: brak pliku'],
    notes: [],
  });
  h.writeFile(root, 'x/exact.js', 'ZMIANA\n');
  h.writeFile(root, 'x/block.txt', `p\n${BEGIN}b1\nB\n${END}b1\n`);
  h.writeFile(root, 'x/seed.txt', 'M1 M2\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ['x/exact.js: rozjazd, suma SHA-256 różni się od manifestu']);
  h.writeFile(root, 'x/exact.js', 'E\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY), { findings: [], notes: [] });
  h.writeFile(root, 'x/block.txt', `p\n${BEGIN}b1\nB2\n${END}b1\n`);
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ["x/block.txt: rozjazd bloku 'b1'"]);
  h.writeFile(root, 'x/block.txt', 'bez znaczników\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ["x/block.txt: brak znaczników bloku 'b1' (po jednym begin i end)"]);
  h.writeFile(root, 'x/block.txt', Buffer.from([0xff, 0xfe]));
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ['x/block.txt: plik nie jest poprawnym UTF-8']);
  h.writeFile(root, 'x/block.txt', `${BEGIN}b1\nB\n${END}b1\n`);
  h.writeFile(root, 'x/seed.txt', 'M1 tylko\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ["x/seed.txt: brak znacznika 'M2'", 'x/seed.txt: rozjazd, suma SHA-256 źródła szablonu różni się od manifestu']);
  h.writeFile(root, 'x/seed.txt', Buffer.from([0xff]));
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ['x/seed.txt: plik nie jest poprawnym UTF-8', 'x/seed.txt: rozjazd, suma SHA-256 źródła szablonu różni się od manifestu']);
});

test('checkSelf: źródło szablonu (source) jest czytane zamiast ścieżki docelowej', (t) => {
  const manifest = manifestOf([{ path: 'dest/seed.txt', source: 'tpl/seed.txt', kind: 'seed', sha256: h.sha256(Buffer.from('M\n')), markers: ['M'] }, { path: params.PARAMS_PATH, kind: 'param' }]);
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, 'dest/seed.txt', 'M\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ['tpl/seed.txt: brak pliku']);
  h.writeFile(root, 'tpl/seed.txt', 'M\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, []);
  h.writeFile(root, 'tpl/seed.txt', 'M inaczej\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ['tpl/seed.txt: rozjazd, suma SHA-256 źródła szablonu różni się od manifestu']);
});

test('checkSelf: pliki wzorca spoza manifestu w katalogach własnych', (t) => {
  const manifest = manifestOf([entry({ path: '.github/standard/listed.js', sha256: h.sha256(Buffer.from('L\n')) }), { path: params.PARAMS_PATH, kind: 'param' }]);
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, '.github/standard/listed.js', 'L\n');
  h.writeFile(root, 'inny/plik.js', 'poza katalogami własnymi\n');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, [], 'brak katalogu scripts/ci nie jest błędem');
  h.writeFile(root, '.github/standard/extra.js', 'x\n');
  h.writeFile(root, '.github/standard/sub/deep.js', 'x\n');
  h.writeFile(root, 'scripts/ci/more.sh', 'x\n');
  const findings = sync.checkSelf(manifest, root, TODAY).findings;
  assert.deepEqual(findings.slice(0, 2).sort(), ['.github/standard/extra.js: plik wzorca nie jest wpisany do manifestu', '.github/standard/sub/deep.js: plik wzorca nie jest wpisany do manifestu']);
  assert.deepEqual(findings.slice(2), ['scripts/ci/more.sh: plik wzorca nie jest wpisany do manifestu'], 'kolejność katalogów własnych');
});

test('checkSelf: plik parametrów wzorca (UTF-8, JSON, schemat, odstępstwa)', (t) => {
  const manifest = manifestOf([{ path: 'a/open.yml', kind: 'exact', sha256: H64, overridable: true }, { path: params.PARAMS_PATH, kind: 'param' }]);
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, 'a/open.yml', 'otwarty\n');
  const withoutParams = sync.checkSelf(manifest, root, TODAY);
  assert.deepEqual(withoutParams.notes, []);
  assert.deepEqual(withoutParams.findings, ['a/open.yml: rozjazd, suma SHA-256 różni się od manifestu']);
  h.writeFile(root, params.PARAMS_PATH, Buffer.from([0xff]));
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY), { findings: ['a/open.yml: rozjazd, suma SHA-256 różni się od manifestu', `${params.PARAMS_PATH}: plik nie jest poprawnym UTF-8`], notes: [] });
  h.writeFile(root, params.PARAMS_PATH, '{');
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY), {
    findings: ['a/open.yml: rozjazd, suma SHA-256 różni się od manifestu', `${params.PARAMS_PATH}: plik parametrów nie jest poprawnym JSON: oczekiwano klucza (pozycja 1)`],
    notes: [],
  });
  const valid = { schema: 1, standard: { version: 'v1.0.0', sha: SHA }, audit: { active_since: '' }, triage: { active_since: '' },
    quality_gate: { workflow: 'q.yml', jobs: ['t'], required: { pull_request: ['t'], push: ['t'], workflow_dispatch: ['t'] } }, review_gate: { protected_paths: [] },
    overrides: [{ path: 'a/open.yml', reason: 'powod', until: '2026-12-01', issue: `o/r${String.fromCharCode(35)}1` }] };
  h.writeFile(root, params.PARAMS_PATH, JSON.stringify(valid));
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY), {
    findings: ['a/open.yml: rozjazd, suma SHA-256 różni się od manifestu'],
    notes: [`odstępstwo a/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane`],
  });
  valid.overrides[0].path = 'nie/w/manifescie.yml';
  h.writeFile(root, params.PARAMS_PATH, JSON.stringify(valid));
  assert.deepEqual(sync.checkSelf(manifest, root, TODAY).findings, ['a/open.yml: rozjazd, suma SHA-256 różni się od manifestu', 'odstępstwo dla pliku spoza manifestu: nie/w/manifescie.yml']);
});

test('checkSelf: błąd inny niż ParamsError nie jest zamieniany na rozjazd', (t) => {
  const manifest = manifestOf([{ path: params.PARAMS_PATH, kind: 'param' }]);
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, params.PARAMS_PATH, '{}');
  const original = params.load;
  params.load = () => { throw new TypeError('awaria wewnętrzna'); };
  try {
    assert.throws(() => sync.checkSelf(manifest, root, TODAY), (error) => error instanceof TypeError && error.message === 'awaria wewnętrzna');
  } finally {
    params.load = original;
  }
});

test('checkConsumer: odstępstwa, plik parametrów i rozjazdy plików', (t) => {
  const data = { exact: 'E\n', block: 'B\n', seed: 'M1 M2\n' };
  const e = plainEntries(data);
  const open = { path: 'x/open.yml', kind: 'exact', sha256: h.sha256(Buffer.from('O\n')), overridable: true };
  const manifest = manifestOf([e.exact, e.block, e.seed, open, { path: params.PARAMS_PATH, kind: 'param' }]);
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const consumer = (overrides = []) => ({ overrides });
  assert.deepEqual(sync.checkConsumer(manifest, root, consumer(), TODAY), {
    findings: ['x/exact.js: brak pliku', 'x/block.txt: brak pliku', 'x/seed.txt: brak pliku', 'x/open.yml: brak pliku', `${params.PARAMS_PATH}: brak pliku parametrów`],
    notes: [],
  });
  h.writeFile(root, 'x/exact.js', 'E\n');
  h.writeFile(root, 'x/block.txt', `${BEGIN}b1\nB\n${END}b1\n`);
  h.writeFile(root, 'x/seed.txt', 'M1 M2 i więcej\n');
  h.writeFile(root, 'x/open.yml', 'O\n');
  h.writeFile(root, params.PARAMS_PATH, '{}');
  assert.deepEqual(sync.checkConsumer(manifest, root, consumer(), TODAY), { findings: [], notes: [] }, 'seed nie wymaga zgodnej sumy u konsumenta');
  const unknown = [{ path: 'nie/ma.yml', reason: 'r', until: '2026-12-01', issue: ISSUE_ID }];
  assert.deepEqual(sync.checkConsumer(manifest, root, consumer(unknown), TODAY).findings, ['odstępstwo dla pliku spoza manifestu: nie/ma.yml']);
  const ok = [{ path: 'x/open.yml', reason: 'r', until: '2026-12-01', issue: ISSUE_ID }];
  assert.deepEqual(sync.checkConsumer(manifest, root, consumer(ok), TODAY), { findings: [], notes: [`odstępstwo x/open.yml: ${params.UNVERIFIED_NOTE}, nie jest uznane`] });
  h.writeFile(root, 'x/open.yml', 'INNE\n');
  assert.deepEqual(sync.checkConsumer(manifest, root, consumer(ok), TODAY).findings, ['x/open.yml: rozjazd, suma SHA-256 różni się od manifestu'], 'odstępstwo nie zwalnia z kontroli pliku');
  h.writeFile(root, 'x/seed.txt', 'M1 tylko\n');
  assert.deepEqual(sync.checkConsumer(manifest, root, consumer(), TODAY).findings.slice(0, 1), ["x/seed.txt: brak znacznika 'M2'"]);
});

// ------------------------------------------------------------------ adresy i tag

test('rawUrl: kształt adresu i odmowa złych danych', () => {
  const endpoints = { raw: 'https://r.test' };
  assert.equal(sync.rawUrl(endpoints, 'CityCouriers/repo-standard', SHA, 'a b/ü.js'), `https://r.test/CityCouriers/repo-standard/${SHA}/a%20b/%C3%BC.js`);
  assert.equal(sync.rawUrl(endpoints, 'o/r', SHA, 'manifest.json'), `https://r.test/o/r/${SHA}/manifest.json`);
  const message = 'zły adres: oczekiwano repo wlasciciel/nazwa i pełnego SHA';
  for (const repo of ['x', 'a/b/c', '', 'a b/c', '/c', 'a/']) assert.throws(() => sync.rawUrl(endpoints, repo, SHA, 'f'), (error) => error instanceof sync.SyncError && error.message === message, repo);
  for (const sha of ['abc', SHA.toUpperCase(), `${SHA}0`, SHA.slice(1), '']) assert.throws(() => sync.rawUrl(endpoints, 'o/r', sha, 'f'), (error) => error.message === message, sha);
});

const apiFetch = (map) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (!(url in map)) throw new sync.SyncError(`brak ${url}`);
    return Buffer.from(typeof map[url] === 'string' ? map[url] : JSON.stringify(map[url]));
  };
  return { fetch, calls };
};
const endpoints = { raw: 'https://raw.test', api: 'https://api.test' };
const REF = 'https://api.test/repos/o/r/git/ref/tags/v1.0.0';
const TAGOBJ = `https://api.test/repos/o/r/git/tags/${'d'.repeat(40)}`;

test('resolveTag: zwykły i opisany tag, adresy zapytań', async () => {
  const plain = apiFetch({ [REF]: { object: { type: 'commit', sha: SHA } } });
  assert.equal(await sync.resolveTag(endpoints, 'o/r', 'v1.0.0', plain.fetch), SHA);
  assert.deepEqual(plain.calls, [REF]);
  const annotated = apiFetch({ [REF]: { object: { type: 'tag', sha: 'd'.repeat(40) } }, [TAGOBJ]: { object: { type: 'commit', sha: SHA } } });
  assert.equal(await sync.resolveTag(endpoints, 'o/r', 'v1.0.0', annotated.fetch), SHA);
  assert.deepEqual(annotated.calls, [REF, TAGOBJ]);
});

test('resolveTag: złe nazwy i złe odpowiedzi API', async () => {
  const never = apiFetch({});
  const names = 'zła nazwa repozytorium albo wersji';
  await assert.rejects(sync.resolveTag(endpoints, 'x', 'v1.0.0', never.fetch), (error) => error instanceof sync.SyncError && error.message === `${names}: x v1.0.0`);
  await assert.rejects(sync.resolveTag(endpoints, 'o/r', '1.0', never.fetch), (error) => error.message === `${names}: o/r 1.0`);
  await assert.rejects(sync.resolveTag(endpoints, 'a/b/c', 'v1', never.fetch), (error) => error.message === `${names}: a/b/c v1`);
  assert.deepEqual(never.calls, [], 'żadne zapytanie nie wyszło przy złych nazwach');
  const resolve = (map) => sync.resolveTag(endpoints, 'o/r', 'v1.0.0', apiFetch(map).fetch);
  const notCommit = 'tag v1.0.0 nie wskazuje commita';
  const commit = (object) => ({ [REF]: { object } });
  for (const object of [undefined, null, 'x', [], { type: 'blob', sha: SHA }, { type: 'commit' }, { type: 'commit', sha: 5 }, { type: 'commit', sha: 'abc' }, { type: 'commit', sha: SHA.toUpperCase() }, { type: 'commit', sha: [SHA] }, { sha: SHA }, { type: 'tag', sha: 'zly' }, { type: 'tag', sha: 5 }, { type: 'tag', sha: ['d'.repeat(40)] }]) {
    await assert.rejects(resolve(commit(object)), (error) => error instanceof sync.SyncError && error.message === notCommit, JSON.stringify(object));
  }
  await assert.rejects(resolve({ [REF]: { object: { type: 'tag', sha: 'd'.repeat(40) } }, [TAGOBJ]: { object: { type: 'tag', sha: SHA } } }), (error) => error.message === notCommit, 'tag wskazujący tag');
  await assert.rejects(resolve({ [REF]: '[]' }), (error) => error.message === 'odpowiedź API (ref) niepoprawna: nie jest obiektem');
  await assert.rejects(resolve({ [REF]: 'null' }), (error) => error.message === 'odpowiedź API (ref) niepoprawna: nie jest obiektem');
  await assert.rejects(resolve({ [REF]: '{zly' }), (error) => error instanceof sync.SyncError && error.message.startsWith('odpowiedź API (ref) niepoprawna: '));
  await assert.rejects(resolve({ [REF]: { object: { type: 'tag', sha: 'd'.repeat(40) } }, [TAGOBJ]: '[]' }), (error) => error.message === 'odpowiedź API (tag) niepoprawna: nie jest obiektem');
  const badUtf8 = async () => Buffer.from([0xff]);
  await assert.rejects(sync.resolveTag(endpoints, 'o/r', 'v1.0.0', badUtf8), (error) => error.message === 'odpowiedź API (ref): nie jest poprawnym UTF-8');
});

// ------------------------------------------------------------------ bezpieczne zapisy

test('assertPlainPath: odmowy z dokładnymi komunikatami', (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  fs.mkdirSync(path.join(root, 'dir'));
  fs.writeFileSync(path.join(root, 'plik.txt'), 'x');
  const message = (rel, tail) => (error) => error instanceof sync.SyncError && error.message === `${rel}: ${tail}`;
  for (const bad of ['../x', '.git/x', 'a/.GIT/x', '/abs']) assert.throws(() => sync.assertPlainPath(root, bad), message(bad, 'niedozwolona ścieżka zapisu (poza repozytorium albo w .git)'));
  assert.throws(() => sync.assertPlainPath(root, 'dir'), message('dir', 'koliduje z istniejącym katalogiem'));
  assert.throws(() => sync.assertPlainPath(root, 'plik.txt/pod'), message('plik.txt/pod', 'koliduje z istniejącym plikiem'));
  assert.throws(() => sync.assertPlainPath(root, 'plik.txt/pod/glebiej'), message('plik.txt/pod/glebiej', 'koliduje z istniejącym plikiem'));
  assert.equal(sync.assertPlainPath(root, 'nowy/plik.txt'), undefined, 'brak elementów ścieżki to dozwolone');
  assert.equal(sync.assertPlainPath(root, 'dir/nowy.txt'), undefined);
  assert.equal(sync.assertPlainPath(root, 'plik.txt'), undefined, 'istniejący plik można nadpisać');
  fs.mkdirSync(path.join(root, 'target'));
  if (h.trySymlink(path.join(root, 'target'), path.join(root, 'link'), 'dir')) {
    assert.throws(() => sync.assertPlainPath(root, 'link/x.txt'), message('link/x.txt', 'ścieżka przechodzi przez dowiązanie symboliczne'));
    assert.throws(() => sync.assertPlainPath(root, 'link'), message('link', 'ścieżka przechodzi przez dowiązanie symboliczne'));
  }
  const original = fs.lstatSync;
  fs.lstatSync = () => { const error = new Error('odmowa dostępu'); error.code = 'EACCES'; throw error; };
  try {
    assert.throws(() => sync.assertPlainPath(root, 'dir/x.txt'), message('dir/x.txt', 'odmowa dostępu'));
  } finally {
    fs.lstatSync = original;
  }
});

test('writeAtomic: zapis, utworzone katalogi, nazwa pliku tymczasowego, kolejność hooków i fsync', (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const created = [];
  const events = [];
  let tempNames;
  const hooks = {
    afterMkdir: (rel, phase) => events.push(['afterMkdir', rel, phase]),
    afterCheck: (rel, phase) => { events.push(['afterCheck', rel, phase]); tempNames = fs.readdirSync(path.join(root, 'a', 'b')); },
    beforeRename: (rel, phase) => events.push(['beforeRename', rel, phase]),
  };
  const originalFsync = fs.fsyncSync;
  const fsyncCalls = [];
  fs.fsyncSync = (fd) => { fsyncCalls.push(typeof fd); return originalFsync(fd); };
  try {
    sync.writeAtomic(root, 'a/b/c.txt', Buffer.from('treść'), hooks, 'write', created);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(fs.readFileSync(path.join(root, 'a', 'b', 'c.txt'), 'utf8'), 'treść');
  assert.deepEqual(created, [path.join(root, 'a'), path.join(root, 'a', 'b')], 'utworzone katalogi od zewnętrznego');
  assert.deepEqual(events, [['afterMkdir', 'a/b/c.txt', 'write'], ['afterCheck', 'a/b/c.txt', 'write'], ['beforeRename', 'a/b/c.txt', 'write']]);
  assert.equal(tempNames.length, 1);
  assert.match(tempNames[0], /^\.c\.txt\.\d+\.[0-9a-f]{12}\.tmp$/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'a', 'b')), ['c.txt'], 'po zapisie nie zostaje plik tymczasowy');
  assert.deepEqual(fsyncCalls, ['number'], 'jeden fsync na deskryptorze');
  sync.writeAtomic(root, 'a/b/c.txt', Buffer.from('nowa'), undefined, 'write');
  assert.equal(fs.readFileSync(path.join(root, 'a', 'b', 'c.txt'), 'utf8'), 'nowa', 'bez created i bez hooków');
  const again = [];
  sync.writeAtomic(root, 'a/b/d.txt', Buffer.from('x'), undefined, 'write', again);
  assert.deepEqual(again, [], 'istniejące katalogi nie są zgłaszane');
});

test('writeAtomic: odmowa przed jakimkolwiek tworzeniem katalogów i kontrola po utworzeniu', (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  assert.throws(() => sync.writeAtomic(root, '.git/nowy/x', Buffer.from('x'), undefined, 'write', []), (error) => error.message === '.git/nowy/x: niedozwolona ścieżka zapisu (poza repozytorium albo w .git)');
  assert.equal(fs.existsSync(path.join(root, '.git')), false, 'katalog .git nie został utworzony');
  const outside = h.tmpDir();
  t.after(() => h.rmDir(outside));
  const hooks = {
    afterMkdir: () => {
      fs.rmSync(path.join(root, 'd'), { recursive: true });
      if (!h.trySymlink(outside, path.join(root, 'd'), 'dir')) throw new Error('brak dowiązań');
    },
  };
  if (h.trySymlink(outside, path.join(root, 'probe'), 'dir')) {
    fs.rmSync(path.join(root, 'probe'));
    assert.throws(() => sync.writeAtomic(root, 'd/x.txt', Buffer.from('x'), hooks, 'write', []), (error) => error.message === 'd/x.txt: ścieżka przechodzi przez dowiązanie symboliczne');
    assert.deepEqual(fs.readdirSync(outside), [], 'nic nie trafiło poza repozytorium');
  }
});

test('writeAtomic: zmiana katalogu docelowego w trakcie zapisu i sprzątanie pliku tymczasowego', (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  const original = fs.realpathSync;
  fs.realpathSync = (value, ...rest) => (value === path.join(root, 'a') ? path.join(root, 'inny') : original(value, ...rest));
  try {
    assert.throws(() => sync.writeAtomic(root, 'a/c.txt', Buffer.from('x'), undefined, 'write', []), (error) => error.message === 'a/c.txt: katalog docelowy zmienił się w trakcie zapisu');
  } finally {
    fs.realpathSync = original;
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'a')), [], 'plik tymczasowy usunięty po błędzie, plik docelowy nie powstał');
});

const failOn = (target, phase = 'write', message = 'boom') => ({ beforeRename: (rel, current) => { if (rel === target && current === phase) throw new Error(message); } });

test('applyWrites: poprawny zapis zwraca listę i pierwsza awaria nic nie zmienia', (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  assert.deepEqual(sync.applyWrites(root, [{ path: 'a/x.txt', content: Buffer.from('1') }, { path: 'y.txt', content: Buffer.from('2') }]), ['a/x.txt', 'y.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'a', 'x.txt'), 'utf8'), '1');
  const other = h.tmpDir();
  t.after(() => h.rmDir(other));
  assert.throws(() => sync.applyWrites(other, [{ path: 'a/b/x.txt', content: Buffer.from('1') }], failOn('a/b/x.txt')), (error) => error instanceof sync.SyncError && error.message === 'awaria zapisu a/b/x.txt (nic nie zmieniono): boom');
  assert.deepEqual(fs.readdirSync(other), [], 'utworzone katalogi sprzątnięte (od najgłębszego)');
});

test('applyWrites: częściowa awaria przywraca pliki w odwrotnej kolejności i sprząta katalogi', (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, 'old.txt', 'OLD');
  const writes = [{ path: 'old.txt', content: Buffer.from('NEW1') }, { path: 'n/m/new.txt', content: Buffer.from('NEW2') }, { path: 'z.txt', content: Buffer.from('NEW3') }];
  assert.throws(() => sync.applyWrites(root, writes, failOn('z.txt')), (error) => error instanceof sync.SyncError && error.message === [
    'częściowa awaria zapisu przy z.txt: boom',
    'zapisano przed awarią: old.txt, n/m/new.txt',
    'przywrócono: n/m/new.txt, old.txt',
  ].join('\n'));
  assert.equal(fs.readFileSync(path.join(root, 'old.txt'), 'utf8'), 'OLD');
  assert.deepEqual(fs.readdirSync(root), ['old.txt'], 'nowy plik i utworzone katalogi usunięte');
});

test('applyWrites: nieudane przywrócenie jest zgłoszone jawnie, a katalogi zostają', (t) => {
  const root = h.tmpDir();
  t.after(() => h.rmDir(root));
  h.writeFile(root, 'a.txt', 'A');
  h.writeFile(root, 'b.txt', 'B');
  const hooks = { beforeRename: (rel, phase) => { if (phase === 'rollback' || rel === 'c.txt') throw new Error('boom'); } };
  const writes = [{ path: 'a.txt', content: Buffer.from('A2') }, { path: 'b.txt', content: Buffer.from('B2') }, { path: 'c.txt', content: Buffer.from('C2') }];
  assert.throws(() => sync.applyWrites(root, writes, hooks), (error) => error.message === [
    'częściowa awaria zapisu przy c.txt: boom',
    'zapisano przed awarią: a.txt, b.txt',
    'przywrócono: nic',
    'NIE przywrócono (napraw ręcznie, np. git checkout): b.txt (boom); a.txt (boom)',
  ].join('\n'));
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'A2', 'plik zostaje w stanie po zapisie');
  const mixed = h.tmpDir();
  t.after(() => h.rmDir(mixed));
  h.writeFile(mixed, 'old.txt', 'OLD');
  const partial = { beforeRename: (rel, phase) => { if ((phase === 'rollback' && rel === 'old.txt') || rel === 'z.txt') throw new Error('boom'); } };
  assert.throws(() => sync.applyWrites(mixed, [{ path: 'old.txt', content: Buffer.from('N') }, { path: 'dir/new.txt', content: Buffer.from('N') }, { path: 'z.txt', content: Buffer.from('N') }], partial), (error) => error.message === [
    'częściowa awaria zapisu przy z.txt: boom',
    'zapisano przed awarią: old.txt, dir/new.txt',
    'przywrócono: dir/new.txt',
    'NIE przywrócono (napraw ręcznie, np. git checkout): old.txt (boom)',
  ].join('\n'));
  assert.equal(fs.existsSync(path.join(mixed, 'dir')), true, 'przy nieudanym przywróceniu katalogi nie są usuwane');
  assert.equal(fs.existsSync(path.join(mixed, 'dir', 'new.txt')), false);
});

test('applyWrites: rollback nie usuwa plików poza repozytorium po podmianie katalogu na dowiązanie', (t) => {
  const root = h.tmpDir();
  const outside = h.tmpDir();
  t.after(() => { h.rmDir(root); h.rmDir(outside); });
  fs.writeFileSync(path.join(outside, 'a.txt'), 'KEEP');
  const probe = path.join(root, 'probe');
  if (!h.trySymlink(outside, probe, 'dir')) return;
  fs.rmSync(probe);
  const hooks = {
    beforeRename: (rel, phase) => {
      if (rel !== 'z.txt' || phase !== 'write') return;
      fs.renameSync(path.join(root, 'd'), path.join(root, 'd.moved'));
      h.trySymlink(outside, path.join(root, 'd'), 'dir');
      throw new Error('boom');
    },
  };
  assert.throws(() => sync.applyWrites(root, [{ path: 'd/a.txt', content: Buffer.from('N') }, { path: 'z.txt', content: Buffer.from('N') }], hooks), (error) => error.message.includes('NIE przywrócono (napraw ręcznie, np. git checkout): d/a.txt (d/a.txt: ścieżka przechodzi przez dowiązanie symboliczne)'));
  assert.equal(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'KEEP', 'plik poza repozytorium nietknięty');
});
