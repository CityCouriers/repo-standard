'use strict';
// Szablony zgłoszeń na wyrenderowanym HTML: TEN SAM czytnik tabeli „Triage” i lista stron podpisu co w bramce audytu
// (importowane z plików bramki, bez kopii i bez atrapy). Gdy bramki audytu albo manifestu etykiet nie ma w `main`,
// odpowiednie testy są oczekujące (pominięte z powodem), nie zielone. Dane wyłącznie syntetyczne.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const SRC = path.join(h.REPO_ROOT, '.github', 'ISSUE_TEMPLATE');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'issue-templates-rendered.json'), 'utf8'));
const KINDS = ['zadanie', 'blad', 'epik'];
const GATE = path.join(h.REPO_ROOT, '.github', 'standard', 'audit', 'issue-audit-gate.js');
const SIDES = path.join(h.REPO_ROOT, '.github', 'standard', 'audit', 'issue-audit-sides.js');
const LABEL_CANDIDATES = ['.github/standard/labels.standard.json', '.github/labels.standard.json', 'labels.standard.json'];

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const rawOf = (kind) => fs.readFileSync(path.join(SRC, `${kind}.md`));
const bodyOf = (kind) => rawOf(kind).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '');

/** Wypełnienie szablonu tak samo, jak przy generowaniu fixture (polecenie w README). */
function fill(body, area) {
  return body.replace('P0-P4', 'P2').replace('T1-T3', 'T1').replace('area:*', area).replace(/^Podpis:.*$/m, '_— Claude Code (agent lokalny)_');
}

const gate = fs.existsSync(GATE) ? require(GATE) : null;
const sides = fs.existsSync(SIDES) ? require(SIDES) : null;
const labelsFile = LABEL_CANDIDATES.map((rel) => path.join(h.REPO_ROOT, ...rel.split('/'))).find((file) => fs.existsSync(file));
const NO_GATE = 'oczekuje: bramki audytu (czytnik „Triage”, strony podpisu) nie ma w main; test nie jest zaliczony';
const NO_LABELS = 'oczekuje: manifestu etykiet nie ma w main; test nie jest zaliczony';

function readFamilies(html) {
  const rows = gate.triageTableRows(html);
  return { P: gate.triageLabelFromTable(rows, 'P'), T: gate.triageLabelFromTable(rows, 'T'), area: gate.triageLabelFromTable(rows, 'area') };
}

test('fixture odpowiada aktualnym szablonom (dryf: odśwież fixture poleceniem z README)', () => {
  assert.deepEqual(Object.keys(FIXTURE.templates).sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    const entry = FIXTURE.templates[kind];
    assert.equal(entry.source_sha256, sha(rawOf(kind)), `${kind}: szablon zmieniony po wygenerowaniu fixture`);
    assert.equal(entry.filled_sha256, sha(fill(bodyOf(kind), 'area:process')), `${kind}: inny sposób wypełnienia niż w fixture`);
    for (const key of ['unfilled', 'filled']) assert.match(entry[key], /<h2[^>]*>Triage/, `${kind}.${key}`);
  }
  assert.equal(FIXTURE.templates.zadanie.literal_area_sha256, sha(fill(bodyOf('zadanie'), 'area:...')));
});

test('fixture: render niewypełnionych szablonów nie zawiera znaczników spoza listy dozwolonych w komórce wartości', () => {
  const allowed = new Set(['a', 'code', 'em', 'strong', 'b', 'i', 'br', 'p', 'del', 's', 'strike']);
  for (const kind of KINDS) {
    const rows = FIXTURE.templates[kind].unfilled.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    assert.equal(rows.length, 4, kind);
    for (const row of rows) {
      for (const cell of row.match(/<td>[\s\S]*?<\/td>/g) || []) {
        const inner = cell.slice(4, -5);
        for (const tag of inner.match(/<\/?([a-z0-9-]+)/gi) || []) assert.ok(allowed.has(tag.replace(/^<\/?/, '').toLowerCase()), `${kind}: znacznik ${tag}`);
      }
    }
  }
});

test('niewypełniony szablon każdego rodzaju nie nadaje żadnej etykiety (P0-P4, T1-T3, area:*)', { skip: gate ? false : NO_GATE }, () => {
  for (const kind of KINDS) assert.deepEqual(readFamilies(FIXTURE.templates[kind].unfilled), { P: '', T: '', area: '' }, kind);
});

test('wypełniony szablon każdego rodzaju daje dokładnie P, T i area', { skip: gate ? false : NO_GATE }, () => {
  for (const kind of KINDS) assert.deepEqual(readFamilies(FIXTURE.templates[kind].filled), { P: 'P2', T: 'T1', area: 'area:process' }, kind);
});

test('literalne area:... jest czytane jako etykieta area:..., więc wzorzec go nie zawiera (przypadek czerwony)', { skip: gate ? false : NO_GATE }, () => {
  assert.equal(readFamilies(FIXTURE.templates.zadanie.literal_area).area, 'area:...');
  for (const kind of KINDS) assert.ok(!rawOf(kind).toString('utf8').includes('area:...'), kind);
});

test('niewypełniony szablon nie jest podpisany, wypełniony ma podpis strony Claude', { skip: sides ? false : NO_GATE }, () => {
  for (const kind of KINDS) {
    assert.equal(sides.signatureSide(bodyOf(kind)), '', `${kind}: niewypełniony`);
    assert.equal(sides.signatureSide(fill(bodyOf(kind), 'area:process')), 'claude', `${kind}: wypełniony`);
  }
});

test('wypełnione wartości są nazwami etykiet z zarządzanego zbioru, a placeholdery i area:... nimi nie są', { skip: labelsFile ? false : NO_LABELS }, () => {
  const manifest = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  const names = new Set((Array.isArray(manifest) ? manifest : manifest.labels).map((label) => label.name));
  for (const value of ['P2', 'T1', 'area:process', 'needs-triage']) assert.ok(names.has(value), value);
  for (const value of ['P0-P4', 'T1-T3', 'area:*', 'area:...']) assert.ok(!names.has(value), value);
});
