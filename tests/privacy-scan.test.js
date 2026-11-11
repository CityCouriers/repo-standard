'use strict';
// AC-4: scripts/ci/privacy-scan.sh. Fragmenty wzorców składane w kodzie, żeby sam plik testu nie wyzwalał skanu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');

const SCRIPT = path.join(h.REPO_ROOT, 'scripts', 'ci', 'privacy-scan.sh');
const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const SKIP = probe.status === 0 ? false : 'brak bash';
const SYNTHETIC_NAME = ['Zyx', 'wv', '-Synt', 'Name'].join('');

const BAD = {
  'ścieżka lokalna': `plik: ${['C', ':\\Us', 'ers\\ktos\\x'].join('')}\n`,
  'katalog domowy': `plik: ${['/ho', 'me/ktos/x'].join('')}\n`,
  'adres e-mail': `kontakt: ${['osoba', '@', 'firma-testowa.pl'].join('')}\n`,
  'identyfikator zgłoszenia': `zob. ${['org-test/prywatne-repo', '#', '123'].join('')}\n`,
  'adres zgłoszenia': `zob. https://${['github', '.com/org-test/prywatne-repo/issues/', '123'].join('')}\n`,
};

function makeRepo(t) {
  const dir = h.tmpDir();
  t.after(() => h.rmDir(dir));
  fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'ci', 'privacy-scan.sh'));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', `user.email=${'noreply@users.noreply.github.com'}`, ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'czysty plik\n');
  return { dir, git };
}

function scan(dir, args = [], env = {}) {
  const result = spawnSync('bash', ['scripts/ci/privacy-scan.sh', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PRIVACY_PATTERNS_FILE: '', ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('czyste repozytorium: kod 0', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  const result = scan(dir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^OK/);
});

for (const [label, content] of Object.entries(BAD)) {
  test(`kod niezerowy: ${label}`, { skip: SKIP }, (t) => {
    const { dir } = makeRepo(t);
    fs.writeFileSync(path.join(dir, 'zly.txt'), content);
    const result = scan(dir);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /BŁĄD/);
  });
}

test('adresy noreply i example są dozwolone, a przykład owner/repo#nr nie jest identyfikatorem', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'ok2.txt'), `a ${'noreply'}@anthropic.com b ${'x'}@example.com, owner/repo${'#'}nr\n`);
  assert.equal(scan(dir).code, 0);
});

test('plik wzorców spoza repozytorium wykrywa zadaną nazwę, a wzorzec i treść nie trafiają do wyjścia', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'tekst.txt'), `linia pierwsza\nklient ${SYNTHETIC_NAME.toUpperCase()} zamawia\n`);
  assert.equal(scan(dir).code, 0, 'bez pliku wzorców nazwa nie jest wykrywana');
  const external = h.tmpDir();
  t.after(() => h.rmDir(external));
  const patterns = path.join(external, 'wzorce.txt');
  fs.writeFileSync(patterns, `# komentarz\n\n${SYNTHETIC_NAME}\r\n`);
  const result = scan(dir, [], { PRIVACY_PATTERNS_FILE: patterns });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /tekst\.txt:2/);
  assert.doesNotMatch(result.out, new RegExp(SYNTHETIC_NAME, 'i'), 'nazwa nie pojawia się w wyjściu');
  assert.doesNotMatch(result.out, /klient/, 'treść wiersza nie pojawia się w wyjściu');
  assert.equal(fs.existsSync(path.join(dir, 'wzorce.txt')), false);
});

test('niepoprawny plik wzorców (brak pliku, same komentarze) kończy się błędem, nie zielonym wynikiem', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  assert.equal(scan(dir, [], { PRIVACY_PATTERNS_FILE: path.join(dir, 'nie-ma.txt') }).code, 2);
  const external = h.tmpDir();
  t.after(() => h.rmDir(external));
  const empty = path.join(external, 'puste.txt');
  fs.writeFileSync(empty, '# tylko komentarz\n\n');
  assert.equal(scan(dir, [], { PRIVACY_PATTERNS_FILE: empty }).code, 2);
});

test('--log: komunikat commita z identyfikatorem zgłoszenia i nazwą z pliku wzorców', { skip: SKIP }, (t) => {
  const { dir, git } = makeRepo(t);
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'czysty komunikat').status, 0);
  const clean = scan(dir, ['--log', 'HEAD']);
  assert.equal(clean.code, 0, clean.out);

  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', `poprawka dla ${['org-test/prywatne-repo', '#', '7'].join('')}`).status, 0);
  const bad = scan(dir, ['--log', 'HEAD~1..HEAD']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /identyfikator zgłoszenia/);

  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', `dla klienta ${SYNTHETIC_NAME}`).status, 0);
  const external = h.tmpDir();
  t.after(() => h.rmDir(external));
  const patterns = path.join(external, 'wzorce.txt');
  fs.writeFileSync(patterns, `${SYNTHETIC_NAME}\n`);
  const named = scan(dir, ['--log', 'HEAD~1..HEAD'], { PRIVACY_PATTERNS_FILE: patterns });
  assert.equal(named.code, 1, named.out);
  assert.doesNotMatch(named.out, new RegExp(SYNTHETIC_NAME, 'i'));
});

test('--log z błędnym zakresem i nieznany argument to kod 2', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  assert.equal(scan(dir, ['--log', 'nie-ma-takiej-rewizji..HEAD']).code, 2);
  assert.equal(scan(dir, ['--zly']).code, 2);
});
