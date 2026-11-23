'use strict';
// AC-1 i AC-2 (walidacja rdzenia i pliku lokalnego) oraz ochrona rdzenia przed migracjami (AC-4, część RED).

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, merge } = require('../.github/standard/labels/labels_sync');
const { CORE_NAMES, REPO, clone, readCore, readLocal, syntheticLocal } = require('./labels-fake');

const errorsOf = (change, { repo = 'owner/repo' } = {}) => {
  const core = readCore();
  const local = syntheticLocal();
  change(core, local);
  return validate(core, local, repo);
};

const rejected = (change, fragment, options) => {
  const errors = errorsOf(change, options);
  assert.ok(errors.length > 0, `oczekiwano błędu: ${fragment}`);
  assert.match(errors.join('\n'), fragment);
};

test('prawdziwy rdzeń i prawdziwy plik lokalny tego repozytorium są poprawne (GREEN)', () => {
  assert.deepEqual(validate(readCore(), readLocal(), REPO), []);
  assert.deepEqual(validate(readCore(), readLocal(), null), []);
});

test('rdzeń zawiera dokładnie 14 etykiet z kolorami rodzin', () => {
  const core = readCore();
  assert.deepEqual(core.labels.map((l) => l.name), CORE_NAMES);
  const colors = Object.fromEntries(core.labels.map((l) => [l.name, l.color]));
  assert.deepEqual(colors, {
    P0: 'B60205', P1: 'F97316', P2: 'EAB308', P3: 'B8C0CC', P4: 'D4D4D8', T1: '93C5FD', T2: '3B82F6', T3: '4338CA',
    blocked: '111827', 'needs-triage': 'FEF2C0', 'by:agent': '475569', 'audit:pending': '0FA5A5', 'audit:changes': '0FA5A5', 'audit:ok': '0FA5A5'
  });
  for (const label of core.labels) assert.doesNotMatch(label.description, /[‐-―−]/, label.name);
});

test('poprawny plik syntetyczny przechodzi, a merge składa rdzeń i lokalne', () => {
  const core = readCore();
  const local = syntheticLocal();
  assert.deepEqual(validate(core, local, 'Owner/Repo'), []);
  const merged = merge(core, local);
  assert.equal(merged.labels.length, 14 + 3);
  assert.deepEqual(merged.coreNames, CORE_NAMES);
  assert.deepEqual(merged.system, ['bug']);
  assert.deepEqual(merged.foreign, ['vendor']);
  assert.deepEqual(merged.migrations, { rename: [], delete: [] });
  const bare = merge(core, { labels: [] });
  assert.deepEqual([bare.system, bare.foreign, bare.migrations], [[], [], { rename: [], delete: [] }]);
});

test('struktura: nie-obiekty, zła schema, nieznane pola, repo', () => {
  assert.deepEqual(validate(null, syntheticLocal(), null), ['rdzeń: oczekiwano obiektu']);
  assert.deepEqual(validate(readCore(), [], null), ['plik lokalny: oczekiwano obiektu']);
  rejected((c) => { c.schema = 2; }, /rdzeń: schema musi wynosić 1/);
  rejected((c, l) => { l.schema = 2; }, /plik lokalny: schema musi wynosić 1/);
  rejected((c) => { c.extra = 1; }, /rdzeń: nieznane pole 'extra'/);
  rejected((c, l) => { l.extra = 1; }, /plik lokalny: nieznane pole 'extra'/);
  rejected((c, l) => { delete l.repo; }, /repo musi mieć postać/);
  rejected((c, l) => { l.repo = 'bez-ukosnika'; }, /repo musi mieć postać/);
  rejected((c, l) => { l.repo = 'a/b/c'; }, /repo musi mieć postać/);
  rejected((c, l) => { l.repo = 'owner/other'; }, /repo wskazuje owner\/other, bieżące repozytorium to owner\/repo/);
  assert.deepEqual(errorsOf((c, l) => { l.repo = 'OWNER/REPO'; }), []);
  rejected((c) => { c.labels = []; }, /labels musi być niepustą tablicą/);
  rejected((c) => { c.labels = 'x'; }, /labels musi być niepustą tablicą/);
  rejected((c, l) => { l.labels = 'x'; }, /plik lokalny: labels musi być tablicą/);
  rejected((c, l) => { l.families = []; }, /plik lokalny\.families: oczekiwano obiektu/);
  rejected((c) => { c.families.by = 'x'; }, /rdzeń\.families\.by: oczekiwano obiektu/);
  rejected((c) => { c.families.by.extra = 1; }, /nieznane pole 'extra'/);
  rejected((c) => { c.families.by.prefix = ''; }, /\.prefix: pusty/);
  rejected((c) => { c.families.by.color = 'zz'; }, /\.color: nie jest 6 znakami hex/);
});

test('etykieta: nazwa, opis, kolor, rodzina', () => {
  const first = (c, l) => l.labels[0];
  rejected((c, l) => { first(c, l).extra = 1; }, /nieznane pole 'extra'/);
  rejected((c, l) => { l.labels[0] = 'x'; }, /oczekiwano obiektu/);
  rejected((c, l) => { first(c, l).name = ''; }, /nazwa: pusty albo nie jest napisem/);
  rejected((c, l) => { first(c, l).name = 5; }, /nazwa: pusty albo nie jest napisem/);
  rejected((c, l) => { first(c, l).name = ' area:one'; }, /nazwa: spacje na brzegach/);
  rejected((c, l) => { first(c, l).name = 'area:one '; }, /nazwa: spacje na brzegach/);
  rejected((c, l) => { first(c, l).name = `area:${'x'.repeat(46)}`; }, /nazwa: 51 znaków, limit 50/);
  assert.deepEqual(errorsOf((c, l) => { first(c, l).name = `area:${'x'.repeat(45)}`; }), []);
  rejected((c, l) => { first(c, l).name = 'area:a\nb'; }, /nazwa: znak sterujący/);
  rejected((c, l) => { first(c, l).name = 'area:é'; }, /nie jest w postaci NFC/);
  rejected((c, l) => { first(c, l).name = 'area:�'; }, /U\+FFFD/);
  rejected((c, l) => { first(c, l).description = ''; }, /opis: pusty/);
  rejected((c, l) => { first(c, l).description = 'x'.repeat(101); }, /opis: 101 znaków, limit 100/);
  assert.deepEqual(errorsOf((c, l) => { first(c, l).description = 'x'.repeat(100); }), []);
  for (const dash of ['‐', '–', '—', '―', '−']) {
    rejected((c, l) => { first(c, l).description = `a ${dash} b`; }, /pauza albo półpauza w opisie/);
  }
  rejected((c, l) => { delete first(c, l).color; }, /kolor nie jest 6 znakami hex/);
  rejected((c, l) => { first(c, l).color = '0E8A1'; }, /kolor nie jest 6 znakami hex/);
  rejected((c, l) => { first(c, l).color = '0E8A16Z'; }, /kolor nie jest 6 znakami hex/);
  rejected((c, l) => { first(c, l).color = 'GE8A16'; }, /kolor nie jest 6 znakami hex/);
  rejected((c, l) => { first(c, l).family = 'nieznana'; }, /nieznana rodzina "nieznana"/);
  rejected((c, l) => { first(c, l).family = 'misc'; }, /rodzina misc wymaga prefiksu|prefiks 'area:' należy do rodziny area/);
  rejected((c, l) => { first(c, l).color = '000000'; }, /kolor 000000 różny od koloru rodziny 0E8A16/);
  assert.deepEqual(errorsOf((c, l) => { first(c, l).color = '0e8a16'; }), []);
});

test('rdzeń i lokalne: kolor rodziny rdzenia, rodzina rdzenia w pliku lokalnym, prefiks cudzej rodziny', () => {
  rejected((c) => { c.labels.find((l) => l.name === 'audit:ok').color = '000000'; }, /kolor 000000 różny od koloru rodziny 0FA5A5/);
  rejected((c) => { c.labels.find((l) => l.name === 'P0').family = 'audit'; }, /rodzina audit wymaga prefiksu 'audit:'/);
  rejected((c, l) => { l.families.audit = {}; }, /rodzina audit należy do rdzenia/);
  rejected((c, l) => { l.labels[2] = { name: 'audit:custom', color: 'AAAAAA', family: 'misc', description: 'Podszywka.' }; }, /prefiks 'audit:' należy do rodziny audit/);
  rejected((c, l) => { l.labels[2] = { name: 'by:other', color: 'AAAAAA', family: 'misc', description: 'Podszywka.' }; }, /prefiks 'by:' należy do rodziny by/);
  rejected((c, l) => { l.labels[0].family = 'priority'; }, /nieznana rodzina "priority"/);
});

test('duplikaty bez względu na wielkość liter: lokalne, z rdzeniem, system, foreign', () => {
  rejected((c, l) => { l.labels.push({ name: 'EXTRA', color: 'AAAAAA', family: 'misc', description: 'Duplikat.' }); }, /duplikat: "EXTRA" \(lokalna\) koliduje z "extra" \(lokalna\)/);
  rejected((c, l) => { l.labels[2].name = 'p0'; }, /duplikat: "p0" \(lokalna\) koliduje z "P0" \(rdzeń\)/);
  rejected((c, l) => { l.system.push('EXTRA'); }, /duplikat: "EXTRA" \(systemowa\) koliduje z "extra" \(lokalna\)/);
  rejected((c, l) => { l.foreign.push('Bug'); }, /duplikat: "Bug" \(obca\) koliduje z "bug" \(systemowa\)/);
  rejected((c, l) => { l.foreign.push('audit:ok'); }, /\(obca\) koliduje z "audit:ok" \(rdzeń\)/);
});

test('system i foreign: tablica napisów w limicie', () => {
  rejected((c, l) => { l.system = 'bug'; }, /system: oczekiwano tablicy/);
  rejected((c, l) => { l.foreign = [5]; }, /foreign 5: pusty albo nie jest napisem/);
  rejected((c, l) => { l.system = ['x'.repeat(51)]; }, /limit 50/);
});

test('wymagane minimum jedna etykieta area:', () => {
  rejected((c, l) => { l.labels = l.labels.filter((x) => !x.name.startsWith('area:')); }, /brak etykiety z prefiksem 'area:'/);
  assert.deepEqual(errorsOf((c, l) => { l.labels = l.labels.filter((x) => x.name !== 'area:two'); }), []);
});

test('migracje: struktura, rename i delete tylko dla etykiet lokalnych', () => {
  const ok = { rename: [{ from: 'old-name', to: 'extra' }], delete: ['stale'] };
  assert.deepEqual(errorsOf((c, l) => { l.migrations = ok; }), []);
  assert.deepEqual(errorsOf((c, l) => { l.migrations = {}; }), []);
  rejected((c, l) => { l.migrations = []; }, /migrations: oczekiwano obiektu/);
  rejected((c, l) => { l.migrations = { zly: [] }; }, /migrations: nieznane pole 'zly'/);
  rejected((c, l) => { l.migrations = { rename: 'x' }; }, /migrations.rename: oczekiwano tablicy/);
  rejected((c, l) => { l.migrations = { delete: 'x' }; }, /migrations.delete: oczekiwano tablicy/);
  rejected((c, l) => { l.migrations = { rename: ['x'] }; }, /wpis musi być obiektem/);
  rejected((c, l) => { l.migrations = { rename: [{ from: 'a', to: 'extra', flaga: 1 }] }; }, /migrations.rename: nieznane pole 'flaga'/);
  rejected((c, l) => { l.migrations = { rename: [{ from: 5, to: 'extra' }] }; }, /from i to muszą być napisami/);
  rejected((c, l) => { l.migrations = { rename: [{ from: 'a', to: 'nieistnieje' }] }; }, /cel nie jest etykietą zarządzaną/);
  rejected((c, l) => { l.migrations = { rename: [{ from: 'extra', to: 'area:one' }] }; }, /źródło nadal jest w manifeście/);
  rejected((c, l) => { l.migrations = { delete: ['extra'] }; }, /etykieta nadal jest w manifeście/);
  rejected((c, l) => { l.migrations = { delete: [{ name: 'stale', allow_in_use: true }] }; }, /wpis musi być napisem \(bez żadnych flag\)/);
});

test('rdzeń jest nieusuwalny i nieprzemianowywalny: każda nazwa, każda wielkość liter, z flagą albo bez (AC-4 RED)', () => {
  for (const name of CORE_NAMES) {
    for (const variant of [name, name.toLowerCase(), name.toUpperCase()]) {
      rejected((c, l) => { l.migrations = { delete: [variant] }; }, /etykieta rdzenia jest nieusuwalna/);
      rejected((c, l) => { l.migrations = { rename: [{ from: variant, to: 'extra' }] }; }, /etykieta rdzenia jest nieprzemianowywalna/);
      rejected((c, l) => { l.migrations = { rename: [{ from: 'old-name', to: variant }] }; }, /etykieta rdzenia jest nieprzemianowywalna/);
    }
    rejected((c, l) => { l.migrations = { delete: [{ name, allow_in_use: true, reason: 'x' }] }; }, /bez żadnych flag/);
  }
});

test('walidacja nie zmienia wejścia', () => {
  const core = readCore();
  const local = syntheticLocal();
  const before = clone({ core, local });
  validate(core, local, 'owner/repo');
  merge(core, local);
  assert.deepEqual({ core, local }, before);
});

test('obejścia z przeglądu: przecinek i nazwy kropkowe w nazwach etykiet i migracji, rdzeń bez etykiet wymaganych przez bramkę', () => {
  rejected((core, local) => { local.labels.push({ name: 'area:a,b', color: '0E8A16', family: 'area', description: 'Opis.' }); }, /przecinek/);
  rejected((core, local) => { local.migrations = { delete: ['a,b'] }; }, /przecinek/);
  rejected((core, local) => { local.migrations = { delete: ['..'] }; }, /'\.' i '\.\.'/);
  rejected((core, local) => { local.migrations = { delete: ['.'] }; }, /'\.' i '\.\.'/);
  rejected((core, local) => { local.migrations = { rename: [{ from: 'a,b', to: 'area:one' }] }; }, /przecinek/);
  rejected((core, local) => { local.migrations = { rename: [{ from: '..', to: 'area:one' }] }; }, /'\.' i '\.\.'/);
  rejected((core, local) => { local.system = ['x,y']; }, /przecinek/);
  rejected((core, local) => { local.foreign = ['..']; }, /'\.' i '\.\.'/);
  for (const name of ['audit:pending', 'audit:ok', 'audit:changes', 'needs-triage', 'P0', 'P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3']) {
    rejected((core) => { core.labels = core.labels.filter((label) => label.name !== name); }, new RegExp(`brak etykiety ${name},`));
  }
  rejected((core) => { core.labels.find((label) => label.name === 'needs-triage').name = 'Needs-Triage'; }, /brak etykiety needs-triage,/);
});
