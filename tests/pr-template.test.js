'use strict';
// Szablon PR: zgodność z manifestem (markery), forma niewypełnionego szablonu, kontrola zerowa i ujemna,
// zgodność README z szablonem i parserem. Dane wyłącznie syntetyczne.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sync = require('../.github/standard/standard_sync');
const syntax = require('../.github/standard/pr-link/pr_link_syntax');
const h = require('./helpers');

const TEMPLATE_PATH = '.github/PULL_REQUEST_TEMPLATE.md';
const MARKERS = ['Fixes #<nr>', '## Dowody', '## Mutacje', '## Ryzyko i wycofanie', 'Podpis:'];
const CONTRACT_HEADINGS = ['## Dowody', '## Mutacje', '## Ryzyko i wycofanie'];
const SIGNATURES = ['_— Claude Code (agent lokalny)_', '_— ChatGPT_'];
const SIDES_FILE = '.github/standard/audit/issue-audit-sides.js';

const read = (rel) => fs.readFileSync(path.join(h.REPO_ROOT, ...rel.split('/')), 'utf8');
const template = read(TEMPLATE_PATH);
const manifest = sync.parseManifest(read('manifest.json'));
const entry = manifest.files.find((item) => item.path === TEMPLATE_PATH);
const count = (text, part) => text.split(part).length - 1;

/** Kontrola zerowa i ujemna: `check --self` na katalogu z samym szablonem i jego wpisem manifestu. */
function selfFindings(text) {
  const root = h.tmpDir();
  try {
    h.writeFile(root, TEMPLATE_PATH, text);
    const local = { schema: 1, version: manifest.version, files: [{ ...entry, sha256: sync.sha256(Buffer.from(template)) }] };
    return sync.checkSelf(local, root, Date.now()).findings;
  } finally {
    h.rmDir(root);
  }
}

/** Szablon wypełniony przykładem: pierwsza linia z numerem i podpis strony zamiast linii instrukcji. */
function filled() {
  const lines = template.replace('Fixes #<nr>', 'Fixes #12').split('\n');
  assert.ok(lines[lines.length - 2].startsWith('Podpis:'));
  lines[lines.length - 2] = SIGNATURES[0];
  return lines.join('\n');
}

/** Kontrola treści wypełnionego PR: powiązanie, sekcje kontraktowe, podpis jako ostatnia niepusta linia. */
function bodyFindings(body) {
  const findings = [...syntax.parse(body).errors];
  for (const heading of CONTRACT_HEADINGS) if (!body.includes(heading)) findings.push(`brak sekcji ${heading}`);
  const last = body.trimEnd().split('\n').pop();
  if (!SIGNATURES.includes(last)) findings.push('ostatnia linia nie jest podpisem strony');
  return findings;
}

test('wpis manifestu: rodzaj seed, bez flag, markery równe oczekiwanym', () => {
  assert.ok(entry);
  assert.equal(entry.kind, 'seed');
  assert.equal(entry.critical, undefined);
  assert.equal(entry.overridable, undefined);
  assert.deepEqual(entry.markers, MARKERS);
  for (const rel of ['.github/standard/pr-link/pr_link_syntax.js', '.github/standard/pr-link/cases.json']) {
    const item = manifest.files.find((candidate) => candidate.path === rel);
    assert.ok(item, rel);
    assert.equal(item.kind, 'exact', rel);
    assert.equal(item.critical, true, rel);
  }
});

test('markery: każdy występuje w szablonie dokładnie raz, każdy nagłówek kontraktowy ma marker', () => {
  for (const marker of entry.markers) assert.equal(count(template, marker), 1, marker);
  for (const heading of CONTRACT_HEADINGS) assert.ok(entry.markers.includes(heading), heading);
  assert.equal(template.split('\n')[0], 'Fixes #<nr>');
  assert.ok(template.endsWith('\n'));
  const lines = template.trimEnd().split('\n');
  assert.ok(lines[lines.length - 1].startsWith('Podpis:'));
});

test('niewypełniony szablon jest czerwony dla parsera, bez innych naruszeń', () => {
  const result = syntax.parse(template);
  assert.equal(result.kind, null);
  assert.equal(result.issue, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^pierwsza linia opisu musi mieć postać/);
  assert.deepEqual(syntax.parse(template.replace('Fixes #<nr>', 'Fixes #12')), { kind: 'Fixes', issue: 12, errors: [] });
  assert.deepEqual(syntax.parse(template.replace('Fixes #<nr>', 'Refs #12')), { kind: 'Refs', issue: 12, errors: [] });
});

test('szablon nie ma słowa zamykającego z numerem ani placeholderów w formie #nr', () => {
  assert.doesNotMatch(template, /#nr\b/);
  assert.equal(count(template, '<nr>'), 1);
  for (const line of template.split('\n').slice(1)) {
    assert.deepEqual(syntax.parse(`Fixes #12\n${line}`).errors, [], line);
  }
  assert.deepEqual(syntax.titleErrors(template), []);
});

test('komentarze HTML są zbalansowane i nie zagnieżdżone', () => {
  let open = false;
  for (const token of template.match(/<!--|-->/g)) {
    assert.notEqual(token === '<!--', open, 'zagnieżdżony albo niezamknięty komentarz');
    open = token === '<!--';
  }
  assert.equal(open, false);
  assert.ok(count(template, '<!--') >= 3);
});

test('szablon nie zawiera półpauz ani pauz poza podpisem i końcówek CRLF', () => {
  const withoutSignatures = SIGNATURES.reduce((text, signature) => text.split(signature).join(''), template);
  assert.doesNotMatch(withoutSignatures, /[–—]/);
  assert.doesNotMatch(template, /\r/);
});

test('podpisy w szablonie są dokładnie dwie dopuszczone formy', () => {
  const last = template.trimEnd().split('\n').pop();
  const found = [...last.matchAll(/`([^`]*)`/g)].map((match) => match[1]);
  assert.deepEqual(found, SIGNATURES);
});

test('podpisy zgodne ze stronami z bramki audytu (oczekuje na jej scalenie)', { todo: !fs.existsSync(path.join(h.REPO_ROOT, SIDES_FILE)) && 'bramka audytu nie jest jeszcze w main' }, () => {
  // Gdy plik stron pojawi się w main, ten test ma porównać podpisy z szablonu ze stronami z bramki (kto wchodzi drugi,
  // dopisuje porównanie); do tego czasu jest zawsze czerwony, żeby nie został pominięty po cichu.
  assert.fail(`${SIDES_FILE}: dopisz porównanie podpisów szablonu ze stronami bramki audytu`);
});

test('kontrola zerowa: szablon bez zmian jest zgodny z manifestem', () => {
  assert.deepEqual(selfFindings(template), []);
});

test('kontrola ujemna: kopia bez któregokolwiek markera jest odrzucona, wskazując ten marker', () => {
  for (const marker of entry.markers) {
    const broken = template.split(marker).join('');
    assert.notEqual(broken, template, marker);
    const findings = selfFindings(broken);
    assert.ok(findings.includes(`${TEMPLATE_PATH}: brak znacznika '${marker}'`), `${marker}: ${JSON.stringify(findings)}`);
    assert.equal(findings.filter((finding) => finding.includes('brak znacznika')).length, 1, marker);
  }
});

test('kontrola ujemna: zmiana treści poza markerami zmienia sumę źródła, ale nie jest brakiem markera', () => {
  const findings = selfFindings(`${template}\nsekcja lokalna\n`);
  assert.deepEqual(findings.filter((finding) => finding.includes('brak znacznika')), []);
  assert.ok(findings.some((finding) => finding.includes('suma SHA-256 źródła szablonu')));
});

test('szablon wypełniony przykładem jest zielony, a warianty czerwone', () => {
  const body = filled();
  assert.deepEqual(bodyFindings(body), []);
  assert.ok(bodyFindings(body.replace(SIGNATURES[0], '')).includes('ostatnia linia nie jest podpisem strony'));
  assert.ok(bodyFindings(body.replace('Fixes #12', 'Treść')).some((finding) => finding.startsWith('pierwsza linia opisu')));
  assert.ok(bodyFindings(`${body.replace(SIGNATURES[0], '')}\nCloses #9\n${SIGNATURES[0]}`).some((finding) => finding.includes('słowo zamykające')));
  assert.ok(bodyFindings(body.replace('## Mutacje', '## Inne')).includes('brak sekcji ## Mutacje'));
  assert.ok(bodyFindings(body.replace('## Dowody', '## Inne')).includes('brak sekcji ## Dowody'));
  assert.ok(bodyFindings(body.replace('## Ryzyko i wycofanie', '## Inne')).includes('brak sekcji ## Ryzyko i wycofanie'));
});

test('README opisuje markery, składnię i pliki parsera zgodnie z szablonem', () => {
  const readme = read('README.md');
  for (const marker of entry.markers) assert.ok(readme.includes(`\`${marker}\``), marker);
  for (const part of ['pr_link_syntax.js', 'cases.json', 'titleErrors', 'parse(body)', 'Fixes #<n>', 'Refs #<n>', 'seed']) {
    assert.ok(readme.includes(part), part);
  }
  assert.doesNotMatch(readme, /Zamknięcie #/);
  assert.doesNotMatch(readme, /pr_link\b(?!_syntax)/);
});
