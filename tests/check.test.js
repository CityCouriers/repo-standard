'use strict';
// AC-1: `check --self` (czysta kopia zgodna, 7 negatywów) oraz `check` konsumenta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { refreshed } = require('../scripts/build_manifest');
const sync = require('../.github/standard/standard_sync');
const params = require('../.github/standard/common/params');
const h = require('./helpers');

const NOW = new Date('2026-11-11T10:00:00Z');
const ISSUE = `owner/repo${'#'}12`;

const BLOCK_V1 = 'updates:\n  - github-actions\n';
const FILES = {
  '.github/standard/standard_sync.js': '// skrypt\n',
  '.github/standard/common/params.js': '// parametry\n',
  'cfg/dependabot.yml': `# lokalne\n# repo-standard:begin actions\n${BLOCK_V1}# repo-standard:end actions\n# lokalne dalej\n`,
  'tpl/seed.md': '# szablon\n<!-- znacznik-a -->\n<!-- znacznik-b -->\n',
};

function baseManifest() {
  return {
    schema: 1,
    version: 'v1.0.0',
    files: [
      { path: '.github/standard/standard_sync.js', kind: 'exact', critical: true },
      { path: '.github/standard/common/params.js', kind: 'exact', critical: true },
      { path: 'cfg/dependabot.yml', kind: 'block', block: 'actions', overridable: true },
      { path: 'tpl/seed.md', kind: 'seed', markers: ['<!-- znacznik-a -->', '<!-- znacznik-b -->'], overridable: true },
      { path: params.PARAMS_PATH, kind: 'param' },
    ],
  };
}

/** Repozytorium wzorca w katalogu tymczasowym z poprawnie przeliczonym manifestem. */
function makeStandardRepo() {
  const root = h.tmpDir();
  for (const [file, content] of Object.entries(FILES)) h.writeFile(root, file, content);
  const manifest = baseManifest();
  for (const entry of manifest.files) if (entry.kind !== 'param') entry.sha256 = '0'.repeat(64);
  fs.writeFileSync(path.join(root, 'manifest.json'), sync.dumpJson(refreshed(manifest, root)));
  return root;
}

const self = (root) => h.run(['check', '--self', '--root', root], { now: NOW });

async function expectRed(t, mutate, pattern) {
  const root = makeStandardRepo();
  t.after(() => h.rmDir(root));
  mutate(root);
  const result = await self(root);
  assert.equal(result.code === 1 || result.code === 2, true, result.out);
  assert.notEqual(result.code, 0, result.out);
  if (pattern) assert.match(result.out, pattern);
}

test('check --self: czysta kopia zwraca 0', async (t) => {
  const root = makeStandardRepo();
  t.after(() => h.rmDir(root));
  const result = await self(root);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /zgodne/);
});

test('check --self: zmiana pliku exact', (t) => expectRed(t, (root) => h.writeFile(root, '.github/standard/standard_sync.js', '// zmiana\n'), /rozjazd/));

test('check --self: zmiana bloku block', (t) => expectRed(t, (root) => {
  h.writeFile(root, 'cfg/dependabot.yml', FILES['cfg/dependabot.yml'].replace('github-actions', 'inne'));
}, /rozjazd bloku/));

test('check --self: usunięcie znacznika seed', (t) => expectRed(t, (root) => {
  h.writeFile(root, 'tpl/seed.md', FILES['tpl/seed.md'].replace('<!-- znacznik-b -->\n', ''));
}, /brak znacznika/));

test('check --self: wygasłe odstępstwo', (t) => expectRed(t, (root) => {
  h.writeFile(root, params.PARAMS_PATH, JSON.stringify(validParams([{ path: 'cfg/dependabot.yml', reason: 'powod', until: '2026-11-10', issue: ISSUE }])));
}, /wygasło/));

test('check --self: odstępstwo dla pliku critical', (t) => expectRed(t, (root) => {
  h.writeFile(root, params.PARAMS_PATH, JSON.stringify(validParams([{ path: '.github/standard/standard_sync.js', reason: 'powod', until: '2026-12-01', issue: ISSUE }])));
}, /krytycznego/));

test('check --self: uszkodzony schemat manifestu', (t) => expectRed(t, (root) => {
  const manifest = JSON.parse(h.readText(root, 'manifest.json'));
  manifest.files[0].kind = 'bogus';
  h.writeFile(root, 'manifest.json', sync.dumpJson(manifest));
}, /manifest niepoprawny/));

test('check --self: brakujący wpis pliku (plik wzorca poza manifestem) i brak pliku z wpisu', async (t) => {
  await expectRed(t, (root) => h.writeFile(root, '.github/standard/nowy.js', '// nowy\n'), /nie jest wpisany do manifestu/);
  await expectRed(t, (root) => fs.rmSync(path.join(root, 'tpl', 'seed.md')), /brak pliku/);
});

test('check --self: manifest z kluczem spoza schematu (np. własny SHA) jest odrzucany', (t) => expectRed(t, (root) => {
  const manifest = JSON.parse(h.readText(root, 'manifest.json'));
  manifest.sha = 'a'.repeat(40);
  h.writeFile(root, 'manifest.json', sync.dumpJson(manifest));
}, /nieznany klucz 'sha'/));

function validParams(overrides = []) {
  return {
    schema: 1,
    standard: { version: 'v1.0.0', sha: 'a'.repeat(40) },
    audit: { active_since: '' },
    triage: { active_since: '' },
    quality_gate: { workflow: 'quality.yml', jobs: ['tests'], required: { pull_request: ['tests'], push: ['tests'], workflow_dispatch: ['tests'] } },
    review_gate: { protected_paths: [] },
    overrides,
  };
}

test('poprawne odstępstwo nie jest uznane: wynik niezweryfikowany, a rozjazd pliku nadal czerwony', async (t) => {
  const root = makeStandardRepo();
  t.after(() => h.rmDir(root));
  h.writeFile(root, params.PARAMS_PATH, JSON.stringify(validParams([{ path: 'cfg/dependabot.yml', reason: 'powod', until: '2026-12-01', issue: ISSUE }])));
  const clean = await self(root);
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.out, /stan zgłoszenia niezweryfikowany/);
  assert.doesNotMatch(clean.out, /zatwierdzon/);
  h.writeFile(root, 'cfg/dependabot.yml', FILES['cfg/dependabot.yml'].replace('github-actions', 'inne'));
  const drift = await self(root);
  assert.equal(drift.code, 1, drift.out);
  assert.match(drift.out, /rozjazd bloku/);
});

test('check --self na prawdziwym repozytorium wzorca jest zielone', async () => {
  const result = await h.run(['check', '--self', '--root', h.REPO_ROOT], { now: NOW });
  assert.equal(result.code, 0, result.out);
});

// ---- check konsumenta (manifest pobierany po przypiętym SHA z lokalnego serwera https)

test('check konsumenta: zgodny, rozjazd i błędy działania', { skip: h.testCert() ? false : 'brak openssl' }, async (t) => {
  const sha = h.fakeSha('check');
  const release = h.makeRelease({ 'tools/a.js': '// a\n' });
  const server = await h.startReleaseServer({ 'v1.0.0': { sha, release } });
  t.after(() => server.close());
  const consumer = h.tmpDir();
  t.after(() => h.rmDir(consumer));
  const deps = { fetch: server.fetch, endpoints: server.endpoints, now: NOW };
  h.writeFile(consumer, 'tools/a.js', '// a\n');
  h.writeFile(consumer, params.PARAMS_PATH, JSON.stringify({ ...validParams(), standard: { version: 'v1.0.0', sha } }));

  const green = await h.run(['check', '--root', consumer], deps);
  assert.equal(green.code, 0, green.out);

  h.writeFile(consumer, 'tools/a.js', '// zmieniony\n');
  const red = await h.run(['check', '--root', consumer], deps);
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /rozjazd/);

  h.writeFile(consumer, 'tools/a.js', '// a\n');
  h.writeFile(consumer, params.PARAMS_PATH, JSON.stringify({ ...validParams(), standard: { version: 'v1.0.1', sha } }));
  const version = await h.run(['check', '--root', consumer], deps);
  assert.equal(version.code, 1, version.out);

  fs.rmSync(path.join(consumer, params.PARAMS_PATH));
  const missing = await h.run(['check', '--root', consumer], deps);
  assert.equal(missing.code, 2, missing.out);
});

test('CLI: nieznane polecenie i niedozwolone flagi dają kod 2', async () => {
  for (const argv of [[], ['nope'], ['apply'], ['check', '--version', 'v1.0.0'], ['apply', '--self', '--version', 'v1.0.0'], ['check', '--zly']]) {
    const result = await h.run(argv, { now: NOW });
    assert.equal(result.code, 2, JSON.stringify(argv));
  }
});
