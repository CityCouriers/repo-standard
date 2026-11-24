'use strict';
// Testy celowane kontraktu szablonów: zabijają mutanty, których nie łapią testy ogólne (pomiar Stryker na kopii).
// Dane wyłącznie syntetyczne.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('../.github/standard/templates/template_contract');
const h = require('./helpers');

const SRC = path.join(h.REPO_ROOT, '.github', 'ISSUE_TEMPLATE');
const SCRIPT = path.join(h.REPO_ROOT, '.github', 'standard', 'templates', 'template_contract.js');
const KINDS = ['zadanie', 'blad', 'epik'];
const SIGNATURE_LINE = 'Podpis: zastąp tę linię jedną z dwóch (zawsze ostatnia linia treści): `_— Claude Code (agent lokalny)_` albo `_— ChatGPT_`';

const VALID = [
  '---',
  'name: Zadanie',
  'about: Opis',
  'labels: needs-triage',
  '---',
  '',
  '**Refs:** #nr albo `brak`',
  '**Rola autora:** Claude Code (agent lokalny) / ChatGPT / właściciel',
  '**Rola recenzenta (audyt specyfikacji):** strona, która nie pisała tej treści',
  '',
  '## Triage',
  '',
  '| pole | wartość |',
  '| --- | --- |',
  '| priorytet | P0-P4 |',
  '| ryzyko | T1-T3 |',
  '| obszar | area:* |',
  '',
  SIGNATURE_LINE,
  '',
].join('\n');

const find = (text) => contract.templateFindings('t.md', text);
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const CONFIG_ERROR = ['config.yml: wymagane dokładnie jedno blank_issues_enabled: false'];

function sandbox(files) {
  const root = h.tmpDir();
  for (const [rel, content] of Object.entries(files)) h.writeFile(root, `.github/ISSUE_TEMPLATE/${rel}`, content);
  return root;
}

test('każda zakazana pauza jest wykrywana pod własnym kodem; kilka naraz po przecinku, bez dubli', () => {
  for (const [ch, code] of [['–', 'U+2013'], ['—', 'U+2014'], ['―', 'U+2015'], ['−', 'U+2212'], ['‒', 'U+2012']]) {
    assert.deepEqual(find(VALID.replace('Opis', `Opis ${ch}`)), [`t.md: półpauza albo pauza poza podpisem: ${code}`], code);
  }
  assert.ok(find(VALID.replace('Opis', 'Opis – — –')).includes('t.md: półpauza albo pauza poza podpisem: U+2013, U+2014'));
});

test('pauza w podpisie jest dozwolona, ta sama pauza obok podpisu nie', () => {
  assert.deepEqual(find(VALID.replace('Opis', '_— ChatGPT_ i _— Claude Code (agent lokalny)_')), []);
  assert.ok(find(VALID.replace('Opis', '_— ChatGPT_ — dalej')).some((finding) => finding.includes('U+2014')));
});

test('parseFrontmatter: bez spacji po dwukropku, ze spacjami na końcu, linie obce ignorowane', () => {
  assert.deepEqual(contract.parseFrontmatter('---\nlabels:needs-triage\nname:   A b  \n---\n'), { labels: 'needs-triage', name: 'A b' });
  assert.deepEqual(contract.parseFrontmatter('---\nkomentarz bez dwukropka\n# name: Z\n  about: W\nName: Q\n---\n'), {});
  assert.deepEqual(contract.parseFrontmatter('---\nabout: a: b\n---\n'), { about: 'a: b' });
  assert.deepEqual(contract.parseFrontmatter('---\n\n---\n'), {});
});

test('bodyOf: ogranicznik musi stać na początku tekstu', () => {
  const text = 'x\n---\na: b\n---\ntreść\n';
  assert.equal(contract.bodyOf(text), text);
  assert.equal(contract.bodyOf('---\na: b\n---\n---\ndruga\n---\nreszta\n'), '---\ndruga\n---\nreszta\n');
});

test('triageRows: nagłówek z końcowymi spacjami, granice poziomów nagłówków, wiersze bez końcowej kreski', () => {
  assert.deepEqual(contract.triageRows('## Triage   \n| a | b |\n'), [['a', 'b']]);
  assert.deepEqual(contract.triageRows('## Triage\n| a | b |\n# Dalej\n| c | d |\n'), [['a', 'b']]);
  assert.deepEqual(contract.triageRows('## Triage\n| a | b |\n###### Dalej\n| c | d |\n'), [['a', 'b']]);
  assert.deepEqual(contract.triageRows('## Triage\n| a | b |\n####### nie nagłówek\n| c | d |\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(contract.triageRows('## Triage\n| a | b |\ntekst ## x\n| c | d |\n#tag\n| e | f |\n'), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
  assert.deepEqual(contract.triageRows('## Triage\ntekst |\n| a | b | c\n| d | e |   \n'), [['a', 'b', 'c'], ['d', 'e']]);
  assert.deepEqual(contract.triageRows('## Triage\n| a | b |\r\n'), [['a', 'b']]);
});

test('tabela Triage: zły drugi nagłówek, wiersz o trzech komórkach i nagłówek nazwany jak wiersz nie dają wiersza danych', () => {
  assert.ok(find(VALID.replace('| pole | wartość |', '| pole | value |')).some((finding) => finding.includes('nagłówki tabeli')));
  assert.ok(find(VALID.replace('| priorytet | P0-P4 |', '| priorytet | P0-P4 | uwagi |')).some((finding) => finding.includes('„priorytet” (jest 0)')));
  assert.ok(find(VALID.replace('| pole | wartość |\n| --- | --- |\n| priorytet | P0-P4 |', '| priorytet | wartość |\n| --- | --- |')).some((finding) => finding.includes('„priorytet” (jest 0)')));
});

test('ostatnia linia: końcowe odstępy, białe linie na końcu, podpis gołym tekstem, tekst przed podpisem', () => {
  assert.deepEqual(find(`${VALID}   \n\n  \n`), []);
  for (const signed of ['_— ChatGPT_  ', '  _— ChatGPT_', '— ChatGPT', '— ChatGPT  ', '_— Claude Code (agent lokalny)_', '— Claude Code (agent lokalny)']) {
    assert.ok(find(`${VALID}${signed}\n`).some((finding) => finding.includes('ważnym podpisem')), signed);
  }
  assert.deepEqual(find(`${VALID}Podpis: x _— ChatGPT_\n`), []);
  assert.deepEqual(find(`${VALID}x_— ChatGPT_\n`).filter((finding) => finding.includes('ważnym podpisem')), []);
  assert.deepEqual(find(`${VALID}— ChatGPT x\n`).filter((finding) => finding.includes('ważnym podpisem')), []);
  const empty = find('---\nname: A\nabout: B\nlabels: needs-triage\n---\n');
  assert.ok(empty.includes('t.md: ostatnia linia musi być instrukcją podpisu (zaczyna się od „Podpis:”)'));
  assert.equal(empty.filter((finding) => finding.includes('ważnym podpisem')).length, 0);
});

test('config.yml: klucz zaczyna linię, wartość jest przycinana, komentarze nie liczą się', () => {
  assert.deepEqual(contract.configFindings('blank_issues_enabled:false\n'), []);
  assert.deepEqual(contract.configFindings('blank_issues_enabled:   false   \n'), []);
  assert.deepEqual(contract.configFindings('# blank_issues_enabled: true\nblank_issues_enabled: false\n'), []);
  assert.deepEqual(contract.configFindings('  blank_issues_enabled: false\n'), CONFIG_ERROR);
  assert.deepEqual(contract.configFindings('x_blank_issues_enabled: false\n'), CONFIG_ERROR);
  assert.deepEqual(contract.configFindings('blank_issues_enabled: false # komentarz\n'), CONFIG_ERROR);
});

test('check: kolejność komunikatów, podkatalog .md nie jest szablonem, błąd odczytu niesie kod systemowy (ENOENT)', () => {
  const bad = VALID.replace('**Refs:**', '**R:**');
  const root = sandbox({ 'b.md': bad, 'a.md': bad, 'config.yml': 'blank_issues_enabled: false\n' });
  fs.mkdirSync(path.join(root, '.github', 'ISSUE_TEMPLATE', 'katalog.md'));
  try {
    assert.deepEqual(contract.checkRoot(root).findings, ['a.md: brak pola **Refs:**', 'b.md: brak pola **Refs:**']);
    // Kolejność odczytu katalogu zależy od systemu plików, więc wymuszamy odwrotną i sprawdzamy, że wynik jest posortowany.
    const original = fs.readdirSync;
    fs.readdirSync = (...args) => original(...args).reverse();
    try {
      assert.deepEqual(contract.checkRoot(root).findings, ['a.md: brak pola **Refs:**', 'b.md: brak pola **Refs:**']);
    } finally {
      fs.readdirSync = original;
    }
    assert.throws(() => contract.checkRoot(path.join(root, 'brak')), /nie można odczytać katalogu \(ENOENT\)/);
  } finally {
    h.rmDir(root);
  }
});

test('main: domyślny katalog to bieżący, składnia argumentów jest ścisła', () => {
  const files = { 'config.yml': fs.readFileSync(path.join(SRC, 'config.yml'), 'utf8') };
  for (const kind of KINDS) files[`${kind}.md`] = fs.readFileSync(path.join(SRC, `${kind}.md`), 'utf8');
  const root = sandbox(files);
  try {
    const here = spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8', cwd: root });
    assert.equal(here.status, 0, here.stderr);
    for (const args of [['check', '--zzz', root], ['check', '--root', root, 'x'], ['check', root, '--root'], ['sprawdz', '--root', root]]) {
      const result = run(args);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stderr, /użycie: template_contract\.js check/);
    }
    assert.equal(run(['check', '--root', root]).status, 0);
  } finally {
    h.rmDir(root);
  }
});

test('dowiązanie symboliczne .md nie jest szablonem (pomijane jak katalog), a zwykły zły plik obok jest wykrywany', (t) => {
  const bad = VALID.replace('**Refs:**', '**R:**');
  const root = sandbox({ 'prawdziwy.md': bad, 'config.yml': 'blank_issues_enabled: false\n' });
  const dir = path.join(root, '.github', 'ISSUE_TEMPLATE');
  try {
    if (!h.trySymlink(path.join(dir, 'prawdziwy.md'), path.join(dir, 'dowiazanie.md'), 'file')) {
      t.skip('brak możliwości tworzenia dowiązań na tym systemie');
      return;
    }
    assert.deepEqual(contract.checkRoot(root).findings, ['prawdziwy.md: brak pola **Refs:**']);
  } finally {
    h.rmDir(root);
  }
});
