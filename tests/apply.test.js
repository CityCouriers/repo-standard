'use strict';
// AC-2: `apply` na lokalnym serwerze https; odmowy bez żadnych zmian w repozytorium konsumenta.

const test = require('node:test');
const assert = require('node:assert/strict');
const params = require('../.github/standard/common/params');
const sync = require('../.github/standard/standard_sync');
const h = require('./helpers');

const NOW = new Date('2026-11-11T10:00:00Z');
const SKIP = h.testCert() ? false : 'brak openssl (testy sieciowe pominięte)';
const SHA = h.fakeSha('release');
const FILES = { 'tools/first.js': '// pierwszy\n', 'tools/sub/second.js': '// drugi\n' };

async function setup(t, { release = h.makeRelease(FILES), intercept, annotated } = {}) {
  const server = await h.startReleaseServer({ 'v1.0.0': { sha: SHA, release, annotated } }, { intercept });
  const root = h.tmpDir();
  t.after(async () => { await server.close(); h.rmDir(root); });
  h.writeFile(root, 'README.md', 'lokalny\n');
  const deps = { fetch: server.fetch, endpoints: server.endpoints, now: NOW };
  return { server, root, deps, before: h.snapshot(root) };
}

const apply = (root, deps, extra = []) => h.run(['apply', '--version', 'v1.0.0', '--root', root, ...extra], deps);

test('poprawne wydanie: pliki zgodne z sumami, SHA z tagu, parametry zapisane na końcu', { skip: SKIP }, async (t) => {
  const { server, root, deps } = await setup(t);
  const result = await apply(root, deps);
  assert.equal(result.code, 0, result.out);
  for (const [file, content] of Object.entries(FILES)) assert.equal(h.readText(root, file), content);
  const written = JSON.parse(h.readText(root, params.PARAMS_PATH));
  assert.deepEqual(written.standard, { version: 'v1.0.0', sha: SHA });
  assert.deepEqual(params.validate(written), []);
  const rawHits = server.hits.filter((url) => url.startsWith('/raw/'));
  assert.ok(rawHits.length >= 3);
  assert.ok(rawHits.every((url) => url.includes(`/${SHA}/`)), 'wszystkie pliki pobrane po SHA tagu');
});

test('tag opisany jest zamieniany na SHA commita, a --sha musi się zgadzać', { skip: SKIP }, async (t) => {
  const { root, deps } = await setup(t, { annotated: h.fakeSha('tagobj') });
  assert.equal((await apply(root, deps, ['--sha', SHA])).code, 0);
  const other = await h.tmpDir();
  t.after(() => h.rmDir(other));
  const mismatch = await apply(other, deps, ['--sha', h.fakeSha('inny')]);
  assert.equal(mismatch.code, 2, mismatch.out);
  assert.match(mismatch.out, /podano --sha/);
  assert.deepEqual(h.snapshot(other), {});
});

test('manifest o innej wersji niż tag albo z deklaracją SHA jest odrzucany', { skip: SKIP }, async (t) => {
  const wrongVersion = h.makeRelease(FILES, { version: 'v1.0.1' });
  const first = await setup(t, { release: wrongVersion });
  const r1 = await apply(first.root, first.deps);
  assert.equal(r1.code, 2, r1.out);
  assert.match(r1.out, /manifest wersji v1\.0\.1/);
  assert.deepEqual(h.snapshot(first.root), first.before);

  const declared = h.makeRelease(FILES);
  declared.manifest.sha = h.fakeSha('deklaracja');
  const second = await setup(t, { release: declared });
  const r2 = await apply(second.root, second.deps);
  assert.equal(r2.code, 2, r2.out);
  assert.match(r2.out, /nieznany klucz 'sha'/);
  assert.deepEqual(h.snapshot(second.root), second.before);
});

async function expectNothingWritten(t, options, pattern, mutateDeps) {
  const ctx = await setup(t, options);
  const deps = mutateDeps ? mutateDeps(ctx) : ctx.deps;
  const result = await apply(ctx.root, deps);
  assert.equal(result.code, 2, result.out);
  if (pattern) assert.match(result.out, pattern);
  assert.deepEqual(h.snapshot(ctx.root), ctx.before, 'repozytorium (także plik parametrów) bez zmian');
  return ctx;
}

test('odmowa i zero zmian: niezgodna suma SHA-256', { skip: SKIP }, async (t) => {
  const release = h.makeRelease(FILES);
  release.manifest.files[0].sha256 = 'f'.repeat(64);
  await expectNothingWritten(t, { release }, /nie zgadza się z sumą/);
});

test('odmowa i zero zmian: przekierowanie na inny host', { skip: SKIP }, async (t) => {
  await expectNothingWritten(t, {
    intercept: (req, res) => {
      if (!req.url.endsWith('/tools/first.js')) return false;
      res.statusCode = 302;
      res.setHeader('Location', req.url.replace(/^/, `https://127.0.0.1:${req.socket.localPort}`));
      res.end();
      return true;
    },
  }, /poza ten sam host/);
});

test('odmowa i zero zmian: http zamiast https (także przez przekierowanie)', { skip: SKIP }, async (t) => {
  const plain = await h.startPlainServer();
  t.after(() => plain.close());
  const direct = await expectNothingWritten(t, {}, /tylko https/, (ctx) => ({ ...ctx.deps, endpoints: { ...ctx.server.endpoints, raw: `http://127.0.0.1:${plain.port}/raw` } }));
  assert.ok(direct);
  await expectNothingWritten(t, {
    intercept: (req, res) => {
      if (!req.url.endsWith('/tools/first.js')) return false;
      res.statusCode = 302;
      res.setHeader('Location', `http://localhost:${plain.port}/x`);
      res.end();
      return true;
    },
  }, /tylko https/);
  assert.deepEqual(plain.hits, [], 'żadne żądanie nie wyszło po http');
});

test('klient https nie ma wyjątku dla http', async () => {
  const plain = await h.startPlainServer();
  try {
    await assert.rejects(sync.makeHttpGet()(`http://127.0.0.1:${plain.port}/x`), /tylko https/);
    assert.deepEqual(plain.hits, []);
  } finally {
    await plain.close();
  }
});

for (const [name, badPath] of [['ścieżka spoza repozytorium (..)', '../outside.txt'], ['ścieżka w .git', '.git/hooks/pre-commit'], ['ścieżka w .GIT (wielkość liter)', '.GIT/config']]) {
  test(`odmowa i zero zmian: ${name}`, { skip: SKIP }, async (t) => {
    const release = h.makeRelease({ ...FILES, [badPath]: 'zlosliwe\n' });
    await expectNothingWritten(t, { release }, /niepoprawny|ścieżki/);
  });
}

test('manifest z dwoma plikami: pierwszy poprawny, drugi z błędną sumą - zero zmian', { skip: SKIP }, async (t) => {
  const release = h.makeRelease({ 'tools/first.js': FILES['tools/first.js'], 'tools/second.js': '// drugi\n' });
  release.manifest.files[1].sha256 = '1'.repeat(64);
  const ctx = await expectNothingWritten(t, { release }, /nie zgadza się z sumą/);
  assert.equal(ctx.server.hits.filter((url) => url.endsWith('/tools/first.js')).length, 1, 'pierwszy plik pobrany i zweryfikowany, ale nie zapisany');
});

test('manifest z dwoma plikami: pierwszy poprawny, drugi z niedozwoloną ścieżką - zero zmian', { skip: SKIP }, async (t) => {
  const release = h.makeRelease({ 'tools/first.js': FILES['tools/first.js'], 'tools/../second.js': '// drugi\n' });
  await expectNothingWritten(t, { release }, /niepoprawny/);
});

test('brak pliku na serwerze albo błąd 404 w środku pobierania: zero zmian', { skip: SKIP }, async (t) => {
  const release = h.makeRelease(FILES);
  delete release.files['tools/sub/second.js'];
  await expectNothingWritten(t, { release }, /status 404/);
});

test('dry-run niczego nie zapisuje', { skip: SKIP }, async (t) => {
  const { root, deps, before } = await setup(t);
  const result = await apply(root, deps, ['--dry-run']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /do zapisu/);
  assert.deepEqual(h.snapshot(root), before);
});

test('niepoprawny istniejący plik parametrów i odstępstwo niedozwolone blokują apply bez zmian', { skip: SKIP }, async (t) => {
  const ctx = await setup(t);
  h.writeFile(ctx.root, params.PARAMS_PATH, '{"schema": 2}');
  const before = h.snapshot(ctx.root);
  const result = await apply(ctx.root, ctx.deps);
  assert.equal(result.code, 2, result.out);
  assert.deepEqual(h.snapshot(ctx.root), before);
});
