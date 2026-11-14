'use strict';
// AC-2a (dowiązania, wyścig) i awaria w trakcie wielu zapisów (przywracanie, jawny raport).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const params = require('../.github/standard/common/params');
const sync = require('../.github/standard/standard_sync');
const h = require('./helpers');

const NOW = new Date('2026-11-11T10:00:00Z');
const SKIP = h.testCert() ? false : 'brak openssl (testy sieciowe pominięte)';
const SHA = h.fakeSha('release-ws');
const FILES = { 'tools/first.js': '// pierwszy\n', 'tools/second.js': '// drugi\n' };
const EXTERNAL = 'ZEWNETRZNY\n';

/** Konsument w podkatalogu `repo`; obok niego plik i katalog poza repozytorium (cele dowiązań). */
async function setup(t, files = FILES) {
  const release = h.makeRelease(files);
  const server = await h.startReleaseServer({ 'v1.0.0': { sha: SHA, release } });
  const base = h.tmpDir();
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  h.writeFile(base, 'outside/file.txt', EXTERNAL);
  h.writeFile(root, 'README.md', 'lokalny\n');
  t.after(async () => { await server.close(); h.rmDir(base); });
  return { base, root, outsideFile: path.join(base, 'outside', 'file.txt'), outsideDir: path.join(base, 'outside'), deps: { fetch: server.fetch, endpoints: server.endpoints, now: NOW } };
}

const apply = (ctx, extraDeps = {}) => h.run(['apply', '--version', 'v1.0.0', '--root', ctx.root], { ...ctx.deps, ...extraDeps });

async function expectRefusal(ctx, extraDeps) {
  const before = h.snapshot(ctx.root);
  const externalBefore = h.snapshot(ctx.outsideDir);
  const result = await apply(ctx, extraDeps);
  assert.equal(result.code, 2, result.out);
  assert.deepEqual(h.snapshot(ctx.root), before, 'repozytorium bez zmian');
  assert.deepEqual(h.snapshot(ctx.outsideDir), externalBefore, 'cel zewnętrzny bez zmian');
  assert.equal(fs.readFileSync(ctx.outsideFile, 'utf8'), EXTERNAL);
  return result;
}

test('(a) dowiązanie samego pliku parametrów wskazujące plik poza repozytorium', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  fs.mkdirSync(path.join(ctx.root, '.github'));
  if (!h.trySymlink(ctx.outsideFile, path.join(ctx.root, params.PARAMS_PATH), 'file')) return t.skip('system nie pozwala na dowiązania plików');
  const result = await expectRefusal(ctx);
  assert.match(result.out, /dowiązanie symboliczne/);
});

test('(b) dowiązanie w katalogu nadrzędnym ścieżki zapisu', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  if (!h.trySymlink(ctx.outsideDir, path.join(ctx.root, 'tools'), 'dir')) return t.skip('system nie pozwala na dowiązania katalogów');
  const result = await expectRefusal(ctx);
  assert.match(result.out, /dowiązanie symboliczne/);
});

test('(c) dowiązanie pliku z manifestu', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  fs.mkdirSync(path.join(ctx.root, 'tools'));
  if (!h.trySymlink(ctx.outsideFile, path.join(ctx.root, 'tools', 'first.js'), 'file')) return t.skip('system nie pozwala na dowiązania plików');
  const result = await expectRefusal(ctx);
  assert.match(result.out, /dowiązanie symboliczne/);
});

test('(d) ścieżki ../ i .git w manifeście: istniejący plik poza repozytorium nie zmienia się', { skip: SKIP }, async (t) => {
  const ctx = await setup(t, { ...FILES, '../outside/file.txt': 'NADPISANY\n' });
  await expectRefusal(ctx);
  const git = await setup(t, { ...FILES, '.git/config': 'NADPISANY\n' });
  await expectRefusal(git);
});

test('wyścig: katalog nadrzędny podmieniony na dowiązanie po kontroli, przed zapisem', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  fs.mkdirSync(path.join(ctx.root, 'tools'));
  let armed = true;
  const hooks = {
    afterCheck: (rel) => {
      if (!armed || rel !== 'tools/first.js') return;
      armed = false;
      fs.renameSync(path.join(ctx.root, 'tools'), path.join(ctx.root, 'tools-orig'));
      if (!h.trySymlink(ctx.outsideDir, path.join(ctx.root, 'tools'), 'dir')) throw new Error('brak dowiązań katalogów');
    },
  };
  const externalBefore = h.snapshot(ctx.outsideDir);
  const result = await apply(ctx, { hooks });
  assert.equal(result.code, 2, result.out);
  assert.deepEqual(h.snapshot(ctx.outsideDir), externalBefore, 'cel zewnętrzny bez zmian');
  assert.equal(fs.existsSync(path.join(ctx.root, 'tools-orig', 'first.js')), false, 'plik docelowy nie powstał');
  assert.equal(fs.existsSync(path.join(ctx.root, params.PARAMS_PATH)), false, 'parametry nie zapisane');
});

test('wyścig: plik docelowy podmieniony na dowiązanie po kontroli, przed zapisem', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  fs.mkdirSync(path.join(ctx.root, 'tools'));
  const target = path.join(ctx.root, 'tools', 'first.js');
  let armed = true;
  const hooks = {
    afterCheck: (rel) => {
      if (!armed || rel !== 'tools/first.js') return;
      armed = false;
      if (!h.trySymlink(ctx.outsideFile, target, 'file')) throw new Error('brak dowiązań plików');
    },
  };
  const result = await apply(ctx, { hooks });
  assert.equal(result.code, 2, result.out);
  assert.equal(fs.readFileSync(ctx.outsideFile, 'utf8'), EXTERNAL, 'cel zewnętrzny bez zmian');
  assert.deepEqual(fs.readdirSync(ctx.outsideDir), ['file.txt']);
});

test('wyścig bez dowiązań: ostatni obrońca to rename, który nie dereferencjonuje dowiązania', async (t) => {
  // Bezpośredni test warstwy zapisu: gdy dowiązanie pojawi się dopiero po ostatniej kontroli, rename podmienia wpis katalogu.
  const base = h.tmpDir();
  t.after(() => h.rmDir(base));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  h.writeFile(base, 'outside/file.txt', EXTERNAL);
  const link = path.join(root, 'victim.txt');
  if (!h.trySymlink(path.join(base, 'outside', 'file.txt'), link, 'file')) return t.skip('system nie pozwala na dowiązania plików');
  assert.throws(() => sync.writeAtomic(root, 'victim.txt', Buffer.from('X'), undefined, 'write'), /dowiązanie/);
  assert.equal(fs.readFileSync(path.join(base, 'outside', 'file.txt'), 'utf8'), EXTERNAL);
});

test('assertPlainPath odrzuca .., .git i skróty NTFS', () => {
  const root = h.tmpDir();
  try {
    for (const bad of ['../x', 'a/../x', '.git/config', 'sub/.git/hooks/x', '.GIT/config', 'GIT~1/config', '/abs', 'a\\b', 'C:x']) {
      assert.throws(() => sync.assertPlainPath(root, bad), /niedozwolona/, bad);
    }
    assert.doesNotThrow(() => sync.assertPlainPath(root, '.github/workflows/ci.yml'));
  } finally {
    h.rmDir(root);
  }
});

// ---- awaria w trakcie wielu zapisów

test('awaria przy drugim zapisie: pierwszy plik przywrócony, nowy usunięty, raport jawny', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  h.writeFile(ctx.root, 'tools/first.js', '// stara wersja\n');
  const before = h.snapshot(ctx.root);
  const hooks = {
    beforeRename: (rel, phase) => {
      if (phase === 'write' && rel === 'tools/second.js') throw new Error('symulowany błąd dysku');
    },
  };
  const result = await apply(ctx, { hooks });
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /częściowa awaria zapisu/);
  assert.match(result.out, /zapisano przed awarią: tools\/first\.js/);
  assert.match(result.out, /przywrócono: tools\/first\.js/);
  assert.deepEqual(Object.keys(h.snapshot(ctx.root)).filter((k) => k.endsWith('.tmp')), [], 'bez plików tymczasowych');
  assert.equal(h.readText(ctx.root, 'tools/first.js'), '// stara wersja\n');
  assert.equal(fs.existsSync(path.join(ctx.root, params.PARAMS_PATH)), false);
  const after = h.snapshot(ctx.root);
  for (const key of Object.keys(before)) assert.equal(after[key], before[key], key);
});

test('awaria przy zapisie parametrów (ostatni): pliki przywrócone w odwrotnej kolejności', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  const hooks = { beforeRename: (rel, phase) => { if (phase === 'write' && rel === params.PARAMS_PATH) throw new Error('symulowany błąd dysku'); } };
  const result = await apply(ctx, { hooks });
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /częściowa awaria zapisu przy \.github\/repo-standard\.json/);
  assert.equal(fs.existsSync(path.join(ctx.root, 'tools', 'first.js')), false);
  assert.equal(fs.existsSync(path.join(ctx.root, 'tools', 'second.js')), false);
});

test('awaria zapisu, której nie da się cofnąć: raport wskazuje pliki do ręcznej naprawy', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  h.writeFile(ctx.root, 'tools/first.js', '// stara wersja\n');
  const hooks = { beforeRename: (rel, phase) => { if (phase === 'rollback' || rel === 'tools/second.js') throw new Error('symulowany błąd dysku'); } };
  const result = await apply(ctx, { hooks });
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /NIE przywrócono/);
  assert.match(result.out, /tools\/first\.js/);
});

test('awaria już przy pierwszym zapisie: nic nie zmieniono', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  const before = h.snapshot(ctx.root);
  const result = await apply(ctx, { hooks: { beforeRename: () => { throw new Error('symulowany błąd dysku'); } } });
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /nic nie zmieniono/);
  assert.deepEqual(h.snapshot(ctx.root), before);
});
