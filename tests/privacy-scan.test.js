'use strict';
// AC-4: scripts/ci/privacy-scan.sh. Fragmenty wzorców składane w kodzie, żeby sam plik testu nie wyzwalał skanu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');

// PRIVACY_SCAN_SCRIPT pozwala uruchomić testy przeciw starszej wersji skryptu (dowód RED).
const SCRIPT = process.env.PRIVACY_SCAN_SCRIPT || path.join(h.REPO_ROOT, 'scripts', 'ci', 'privacy-scan.sh');
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

// --- Poprawki po audycie PR #4 -----------------------------------------------------------------

const LEAK = {
  'ścieżka lokalna': { value: ['C', ':\\Us', 'ers\\ktos\\x'].join(''), secrets: ['ktos'] },
  'katalog domowy': { value: ['/ho', 'me/ktos/x'].join(''), secrets: ['ktos'] },
  'adres e-mail': { value: ['osoba', '@', 'firma-testowa.pl'].join(''), secrets: ['osoba', 'firma-testowa'] },
  'identyfikator zgłoszenia': { value: ['org-test/prywatne-repo', '#', '123'].join(''), secrets: ['org-test', 'prywatne-repo'] },
  'adres zgłoszenia': { value: `https://${['github', '.com/org-test/prywatne-repo/issues/', '123'].join('')}`, secrets: ['org-test', 'prywatne-repo'] },
};

for (const [label, { value, secrets }] of Object.entries(LEAK)) {
  test(`wyjście nie ujawnia wartości ani otoczenia trafienia: ${label}`, { skip: SKIP }, (t) => {
    const { dir } = makeRepo(t);
    fs.writeFileSync(path.join(dir, 'zly.txt'), `linia zero\nOTOCZENIEPRZED ${value} OTOCZENIEPO\n`);
    const result = scan(dir);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /zly\.txt:2/);
    for (const secret of [...secrets, 'OTOCZENIE', 'linia zero']) {
      assert.equal(result.out.toLowerCase().includes(secret.toLowerCase()), false, `w wyjściu jest "${secret}": ${result.out}`);
    }
  });
}

test('skan obejmuje sam skaner: syntetyczny identyfikator, adres e-mail i ścieżka w skrypcie dają kod 1 bez wycieku', { skip: SKIP }, (t) => {
  const cases = {
    identyfikator: ['# zob. org-test/prywatne-repo', '#', '5'].join(''),
    'adres e-mail': ['# kontakt: osoba', '@', 'firma-testowa.pl'].join(''),
    'ścieżka': ['# ', 'C', ':\\Us', 'ers\\ktos'].join(''),
  };
  for (const [label, line] of Object.entries(cases)) {
    const { dir } = makeRepo(t);
    const script = path.join(dir, 'scripts', 'ci', 'privacy-scan.sh');
    fs.appendFileSync(script, `\n${line}\n`);
    const result = scan(dir);
    assert.equal(result.code, 1, `${label}: ${result.out}`);
    assert.match(result.out, /scripts\/ci\/privacy-scan\.sh:\d+/, label);
    assert.doesNotMatch(result.out, /prywatne-repo|firma-testowa|ktos/, `${label}: wyciek`);
  }
});

test('skan obejmuje sam skaner: nazwa z pliku wzorców w skrypcie daje kod 1', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  fs.appendFileSync(path.join(dir, 'scripts', 'ci', 'privacy-scan.sh'), `\n# ${SYNTHETIC_NAME}\n`);
  const external = h.tmpDir();
  t.after(() => h.rmDir(external));
  const patterns = path.join(external, 'wzorce.txt');
  fs.writeFileSync(patterns, `${SYNTHETIC_NAME}\n`);
  const result = scan(dir, [], { PRIVACY_PATTERNS_FILE: patterns });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /privacy-scan\.sh:\d+/);
});

function shimDir(t, scripts) {
  const dir = h.tmpDir();
  t.after(() => h.rmDir(dir));
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

const withShim = (dir) => ({ PATH: `${dir}${path.delimiter}${process.env.PATH}` });

test('fail-closed: błąd git ls-files to kod 2, nie OK', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  const shim = shimDir(t, { git: 'exit 1' });
  const result = scan(dir, [], withShim(shim));
  assert.equal(result.code, 2, result.out);
  assert.doesNotMatch(result.out, /^OK/m);
});

test('fail-closed: błąd grep na wybranym pliku (kod 2) to kod 2, nie OK', { skip: SKIP }, (t) => {
  const { dir } = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'zepsuty.txt'), 'czysty\n');
  // Pierwszy grep w PATH to atrapa; reszta wywołań idzie do prawdziwego grep.
  const shim = shimDir(t, {
    grep: 'for a in "$@"; do [ "$a" = "zepsuty.txt" ] && { echo "grep: zepsuty.txt: blad" >&2; exit 2; }; done\nreal="$(type -ap grep | sed -n 2p)"\nexec "$real" "$@"',
  });
  const result = scan(dir, [], withShim(shim));
  assert.equal(result.code, 2, result.out);
  assert.doesNotMatch(result.out, /^OK/m);
});

test('fail-closed: błąd grep przy skanie commitów (--log) to kod 2', { skip: SKIP }, (t) => {
  const { dir, git } = makeRepo(t);
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'czysty komunikat').status, 0);
  const shim = shimDir(t, {
    grep: 'for a in "$@"; do [ "$a" = "-q" ] && exit 2; done\nreal="$(type -ap grep | sed -n 2p)"\nexec "$real" "$@"',
  });
  const result = scan(dir, ['--log', 'HEAD'], withShim(shim));
  assert.equal(result.code, 2, result.out);
  assert.doesNotMatch(result.out, /^OK/m);
});

test('fail-closed: nieczytelny plik to kod 2', { skip: SKIP || process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'brak chmod lub root' : false }, (t) => {
  const { dir } = makeRepo(t);
  const file = path.join(dir, 'zamkniety.txt');
  fs.writeFileSync(file, 'czysty\n');
  fs.chmodSync(file, 0o000);
  t.after(() => fs.chmodSync(file, 0o644));
  const result = scan(dir);
  assert.equal(result.code, 2, result.out);
});

test('fail-closed: uszkodzone dowiązanie i nazwa z dwukropkiem to kod 2', { skip: SKIP || process.platform === 'win32' ? 'brak dowiązań lub dwukropków w nazwach' : false }, (t) => {
  const { dir } = makeRepo(t);
  fs.symlinkSync(path.join(dir, 'nie-ma-celu'), path.join(dir, 'zerwane'));
  assert.equal(scan(dir).code, 2);
  fs.rmSync(path.join(dir, 'zerwane'));
  fs.writeFileSync(path.join(dir, 'a:b.txt'), 'x\n');
  assert.equal(scan(dir).code, 2);
});

// --- Allowlista e-mail: pełne adresy, zakotwiczona (reaudyt PR #4) -----------------------------

const EVIL_EMAILS = [
  ['account-noreply', '@', 'private.test'].join(''),
  ['test', '@', 'example.com.evil'].join(''),
  ['no-reply', '@', 'firma-testowa.pl'].join(''),
  ['x', '@', 'users.noreply.github.com.evil'].join(''),
  ['noreply', '@', 'anthropic.com.evil'].join(''),
  ['x', '@', 'notexample.com'].join(''),
];

const GOOD_EMAILS = [
  ['noreply', '@', 'anthropic.com'].join(''),
  ['12345+osoba', '@', 'users.noreply.github.com'].join(''),
  ['Osoba', '@', 'Example.COM'].join(''),
  ['a.b', '@', 'example.org'].join(''),
  ['x', '@', 'example.net'].join(''),
  ['noreply', '@', 'github.com'].join(''),
];

test('e-mail spoza allowlisty (także z "noreply" w części lokalnej i obcą domeną) to kod 1 bez wycieku, w plikach', { skip: SKIP }, (t) => {
  for (const mail of EVIL_EMAILS) {
    const { dir } = makeRepo(t);
    fs.writeFileSync(path.join(dir, 'mail.txt'), `OTOCZENIE ${mail} OTOCZENIE\n`);
    const result = scan(dir);
    assert.equal(result.code, 1, `${mail}: ${result.out}`);
    assert.match(result.out, /mail\.txt:1/);
    assert.doesNotMatch(result.out, /private\.test|evil|firma-testowa|notexample|OTOCZENIE/i, `wyciek dla ${mail}`);
  }
});

test('e-mail spoza allowlisty w komunikacie commita i w metadanych autora (--log) to kod 1, tylko kategoria', { skip: SKIP }, (t) => {
  for (const mail of EVIL_EMAILS) {
    const { dir, git } = makeRepo(t);
    git('add', '-A');
    assert.equal(git('commit', '-q', '-m', `opis ${mail} koniec`).status, 0);
    const result = scan(dir, ['--log', 'HEAD']);
    assert.equal(result.code, 1, `${mail}: ${result.out}`);
    assert.match(result.out, /adres e-mail/);
    assert.doesNotMatch(result.out, /private\.test|evil|firma-testowa|notexample|opis|koniec/i, `wyciek dla ${mail}`);
  }
  const { dir, git } = makeRepo(t);
  git('add', '-A');
  const author = spawnSync('git', ['-c', 'user.name=Test', '-c', `user.email=${EVIL_EMAILS[0]}`, 'commit', '-q', '-m', 'czysty'], { cwd: dir, encoding: 'utf8' });
  assert.equal(author.status, 0, author.stderr);
  const result = scan(dir, ['--log', 'HEAD']);
  assert.equal(result.code, 1, result.out);
  assert.doesNotMatch(result.out, /private\.test/);
});

test('dozwolone adresy (noreply Anthropic i GitHub, *@users.noreply.github.com, *@example.com/org/net) przechodzą w plikach i w --log', { skip: SKIP }, (t) => {
  const { dir, git } = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'ok-mail.txt'), `${GOOD_EMAILS.join('\n')}\n`);
  assert.equal(scan(dir).code, 0);
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', `autor\n\nCo-Authored-By: Ktos <${GOOD_EMAILS.join('> <')}>`).status, 0);
  const result = scan(dir, ['--log', 'HEAD']);
  assert.equal(result.code, 0, result.out);
});
