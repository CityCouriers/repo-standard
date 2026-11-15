'use strict';
// Kontrakt szablonów zgłoszeń: kontrola zerowa (źródła wzorca zgodne) i kontrola ujemna (każde naruszenie czerwone).
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

const read = (kind) => fs.readFileSync(path.join(SRC, `${kind}.md`), 'utf8');
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

function sandbox(files) {
  const root = h.tmpDir();
  for (const [rel, content] of Object.entries(files)) h.writeFile(root, `.github/ISSUE_TEMPLATE/${rel}`, content);
  return root;
}

test('kontrola zerowa: szablon syntetyczny i wszystkie źródła wzorca są zgodne', () => {
  assert.deepEqual(contract.templateFindings('t.md', VALID), []);
  for (const kind of KINDS) assert.deepEqual(contract.templateFindings(`${kind}.md`, read(kind)), [], kind);
  assert.deepEqual(contract.configFindings(fs.readFileSync(path.join(SRC, 'config.yml'), 'utf8')), []);
});

test('kontrola ujemna: każde naruszenie daje dokładnie oczekiwany komunikat', () => {
  const cases = [
    ['CR', VALID.replace(/\n/g, '\r\n'), 'bajt CR'],
    ['półpauza w treści', VALID.replace('Opis', 'Opis – dalej'), 'U+2013'],
    ['pauza w treści', VALID.replace('Opis', 'Opis — dalej'), 'U+2014'],
    ['brak frontmattera', VALID.slice(VALID.indexOf('**Refs')), 'brak frontmattera'],
    ['brak name', VALID.replace('name: Zadanie\n', ''), 'frontmatter bez pola name'],
    ['pusty about', VALID.replace('about: Opis', 'about:'), 'frontmatter bez pola about'],
    ['obca etykieta', VALID.replace('labels: needs-triage', 'labels: bug'), 'labels musi być dokładnie needs-triage'],
    ['dwie etykiety', VALID.replace('labels: needs-triage', 'labels: needs-triage, bug'), 'labels musi być dokładnie needs-triage'],
    ['brak Refs', VALID.replace('**Refs:**', '**Ref:**'), 'brak pola **Refs:**'],
    ['brak roli autora', VALID.replace('**Rola autora:**', '**Autor:**'), 'brak pola **Rola autora:**'],
    ['brak roli recenzenta', VALID.replace('**Rola recenzenta', '**Recenzent'), 'brak pola **Rola recenzenta'],
    ['brak sekcji Triage', VALID.replace('## Triage', '## Inne'), 'brak sekcji „Triage”'],
    ['Triage trzeciego poziomu', VALID.replace('## Triage', '### Triage'), 'brak sekcji „Triage”'],
    ['zły nagłówek tabeli', VALID.replace('| pole | wartość |', '| klucz | wartość |'), 'nagłówki tabeli „Triage”'],
    ['trzy kolumny', VALID.replace('| pole | wartość |', '| pole | wartość | uwagi |'), 'nagłówki tabeli „Triage”'],
    ['brak wiersza priorytet', VALID.replace('| priorytet | P0-P4 |\n', ''), 'wiersz „priorytet” (jest 0)'],
    ['brak wiersza ryzyko', VALID.replace('| ryzyko | T1-T3 |\n', ''), 'wiersz „ryzyko” (jest 0)'],
    ['zmieniona nazwa wiersza obszar', VALID.replace('| obszar |', '| area |'), 'wiersz „obszar” (jest 0)'],
    ['zdublowany wiersz', VALID.replace('| ryzyko | T1-T3 |', '| ryzyko | T1-T3 |\n| ryzyko | T2 |'), 'wiersz „ryzyko” (jest 2)'],
    ['ostatnia linia nie jest instrukcją', VALID.replace(SIGNATURE_LINE, 'Koniec'), 'zaczyna się od „Podpis:”'],
    ['ważny podpis Claude', `${VALID}_— Claude Code (agent lokalny)_\n`, 'ważnym podpisem'],
    ['ważny podpis GPT', `${VALID}_— ChatGPT_\n`, 'ważnym podpisem'],
    ['podpis jako instrukcja ostatnia, ale bez „Podpis:”', VALID.replace(SIGNATURE_LINE, '_— ChatGPT_'), 'ważnym podpisem'],
  ];
  for (const [label, text, expected] of cases) {
    const findings = contract.templateFindings('t.md', text);
    assert.ok(findings.some((finding) => finding.includes(expected)), `${label}: ${JSON.stringify(findings)}`);
    assert.ok(findings.every((finding) => finding.startsWith('t.md: ')), label);
  }
});

test('podpis w środku treści nie zastępuje instrukcji, a pauza w nazwie podpisu jest dozwolona', () => {
  assert.deepEqual(contract.templateFindings('t.md', VALID), []);
  assert.deepEqual(contract.templateFindings('t.md', VALID.replace('Opis', 'Opis _— ChatGPT_')), []);
});

test('triageRows: tylko sekcja Triage, przerwanie na kolejnym nagłówku, wiersze bez prefiksu', () => {
  assert.deepEqual(contract.triageRows('## Triage\n| a | b |\ntekst\n| c | d |\n## Dalej\n| e | f |\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(contract.triageRows('| a | b |\n'), []);
  assert.deepEqual(contract.triageRows('## Triage dodatkowe\n| a | b |\n'), []);
  assert.deepEqual(contract.triageRows('# Triage\n| a | b |\n'), []);
});

test('config.yml: wymagane dokładnie jedno blank_issues_enabled: false', () => {
  assert.deepEqual(contract.configFindings('blank_issues_enabled: false\n'), []);
  assert.deepEqual(contract.configFindings('# komentarz blank_issues_enabled: true\nblank_issues_enabled: false\ncontact_links: []\n'), []);
  for (const bad of ['blank_issues_enabled: true\n', '# blank_issues_enabled: false\n', '', 'blank_issues_enabled: false\nblank_issues_enabled: false\n', 'blank_issues_enabled: "false"\n']) {
    assert.deepEqual(contract.configFindings(bad), ['config.yml: wymagane dokładnie jedno blank_issues_enabled: false'], JSON.stringify(bad));
  }
  assert.deepEqual(contract.configFindings('blank_issues_enabled: false\r\n'), ['config.yml: bajt CR (wymagane końce linii LF)']);
});

test('parseFrontmatter i bodyOf', () => {
  assert.deepEqual(contract.parseFrontmatter('---\nname: A\nabout: B\nlabels: needs-triage\n---\ntreść\n'), { name: 'A', about: 'B', labels: 'needs-triage' });
  assert.equal(contract.parseFrontmatter('treść\n'), null);
  assert.equal(contract.parseFrontmatter('x\n---\nname: A\n---\n'), null);
  assert.equal(contract.bodyOf('---\nname: A\n---\ntreść\n'), 'treść\n');
  assert.equal(contract.bodyOf('treść\n'), 'treść\n');
});

test('check: katalog ze źródłami wzorca jest zgodny, brak katalogu to błąd działania, naruszenie to kod 1', () => {
  const files = { 'config.yml': fs.readFileSync(path.join(SRC, 'config.yml'), 'utf8') };
  for (const kind of KINDS) files[`${kind}.md`] = read(kind);
  const root = sandbox(files);
  try {
    const ok = run(['check', '--root', root]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /zgodne z kontraktem/);
    assert.deepEqual(contract.checkRoot(root), { findings: [] });

    h.writeFile(root, '.github/ISSUE_TEMPLATE/README.md', 'inny plik bez frontmattera\n');
    assert.equal(run(['check', '--root', root]).status, 0, 'README.md w katalogu szablonów nie jest szablonem');

    h.writeFile(root, '.github/ISSUE_TEMPLATE/config.yml', 'blank_issues_enabled: true\n');
    const bad = run(['check', '--root', root]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /config\.yml: wymagane dokładnie jedno blank_issues_enabled: false/);
  } finally {
    h.rmDir(root);
  }
  const empty = h.tmpDir();
  try {
    const missing = run(['check', '--root', empty]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /nie można odczytać katalogu/);
  } finally {
    h.rmDir(empty);
  }
});

test('check: katalog bez szablonów i brak config.yml to naruszenia', () => {
  const root = sandbox({ 'notatka.txt': 'x' });
  try {
    const { findings } = contract.checkRoot(root);
    assert.deepEqual(findings, ['.github/ISSUE_TEMPLATE: brak szablonów .md', 'config.yml: brak pliku']);
  } finally {
    h.rmDir(root);
  }
});

test('check: błędne użycie to kod 2 z podpowiedzią', () => {
  for (const args of [[], ['inne'], ['check', '--root'], ['check', 'x'], ['check', '--root', '']]) {
    const result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /użycie: template_contract\.js check/);
  }
});
