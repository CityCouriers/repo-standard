'use strict';
// AC-3 (część planu): różnica manifestu i stanu żywego, bez sieci.

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, plan, inSync, pending } = require('../.github/standard/labels/labels_sync');
const { readCore, syntheticLocal, liveFor } = require('./labels-fake');

const build = (change = () => {}) => {
  const core = readCore();
  const local = syntheticLocal();
  change(local);
  return { core, local, manifest: merge(core, local) };
};

test('stan zgodny: wszystko bez zmian, plan pusty, system i foreign nieobecne tylko odnotowane', () => {
  const { core, local, manifest } = build();
  const p = plan(manifest, liveFor(core, local));
  assert.equal(p.unchanged.length, 17);
  assert.deepEqual([p.create, p.update, p.rename, p.delete, p.unclassified, p.conflicts], [[], [], [], [], [], []]);
  assert.deepEqual(p.missingKnown, ['bug', 'vendor']);
  assert.equal(pending(p), false);
  assert.equal(inSync(p), true);
});

test('puste repozytorium: tworzy wszystko w kolejności manifestu', () => {
  const { manifest } = build();
  const p = plan(manifest, []);
  assert.deepEqual(p.create.map((l) => l.name), manifest.labels.map((l) => l.name));
  assert.equal(pending(p), true);
  assert.equal(inSync(p), false);
});

test('dryf koloru, opisu i wielkości liter nazwy daje poprawkę z opisem zmiany', () => {
  const { core, local, manifest } = build();
  const live = liveFor(core, local);
  live[0] = { ...live[0], color: '000000' };
  live[1] = { ...live[1], description: 'inny opis' };
  live[2] = { ...live[2], name: 'p2' };
  live[3] = { ...live[3], color: live[3].color.toUpperCase() };
  const p = plan(manifest, live);
  assert.deepEqual(p.update.map((u) => [u.name, u.what]), [['P0', ['kolor']], ['P1', ['opis']], ['p2', ['nazwa']]]);
  assert.equal(p.update[0].label.name, 'P0');
  assert.ok(p.unchanged.includes('P3'), 'wielkość liter koloru nie jest dryfem');
});

test('opis null albo brak opisu w stanie żywym liczy się jak pusty', () => {
  const { core, local, manifest } = build();
  const live = liveFor(core, local).map((l, i) => (i === 0 ? { name: l.name, color: l.color, description: null } : l));
  assert.deepEqual(plan(manifest, live).update.map((u) => [u.name, u.what]), [['P0', ['opis']]]);
});

test('etykieta spoza manifestu, system i foreign jest niesklasyfikowana albo znana, nigdy usuwana', () => {
  const { core, local, manifest } = build();
  const live = liveFor(core, local, [
    { name: 'zzz', color: 'ffffff', description: '' }, { name: 'aaa', color: 'ffffff', description: '' },
    { name: 'BUG', color: 'ffffff', description: '' }, { name: 'vendor', color: 'ffffff', description: '' }
  ]);
  const p = plan(manifest, live);
  assert.deepEqual(p.unclassified, ['aaa', 'zzz']);
  assert.deepEqual(p.missingKnown, []);
  assert.deepEqual(p.delete, []);
  assert.equal(inSync(p), false);
});

test('duplikat w stanie żywym (wielkość liter) to konflikt', () => {
  const { core, local, manifest } = build();
  const live = liveFor(core, local, [{ name: 'EXTRA', color: 'aaaaaa', description: 'Etykieta lokalna.' }]);
  const p = plan(manifest, live);
  assert.deepEqual(p.conflicts, ['duplikat w repozytorium: "EXTRA"']);
  assert.equal(inSync(p), false);
});

test('migracja rename: zmiana nazwy zachowuje etykietę, a plan ją potem wyrównuje', () => {
  const { core, local, manifest } = build((l) => { l.migrations = { rename: [{ from: 'old-extra', to: 'extra' }], delete: [] }; });
  const live = liveFor(core, local).filter((l) => l.name !== 'extra');
  live.push({ name: 'Old-Extra', color: 'aaaaaa', description: 'Etykieta lokalna.' });
  const p = plan(manifest, live);
  assert.deepEqual(p.rename, [['Old-Extra', 'extra']]);
  assert.deepEqual(p.create, []);
  assert.deepEqual(p.update, []);
  assert.equal(p.unchanged.includes('extra'), false);
  assert.deepEqual(p.unclassified, []);
  const drifted = live.map((l) => (l.name === 'Old-Extra' ? { ...l, color: '111111' } : l));
  assert.deepEqual(plan(manifest, drifted).update.map((u) => [u.name, u.what]), [['extra', ['kolor']]]);
});

test('migracja rename: gdy istnieją obie nazwy, to konflikt bez przemianowania', () => {
  const { core, local, manifest } = build((l) => { l.migrations = { rename: [{ from: 'old-extra', to: 'extra' }], delete: [] }; });
  const live = liveFor(core, local, [{ name: 'old-extra', color: 'aaaaaa', description: '' }]);
  const p = plan(manifest, live);
  assert.deepEqual(p.rename, []);
  assert.deepEqual(p.conflicts, ['migracja "old-extra" -> "extra": obie etykiety istnieją']);
  assert.deepEqual(p.unclassified, [], 'źródło migracji jest zajęte, nie jest niesklasyfikowane');
});

test('migracja rename bez źródła w repozytorium nic nie planuje', () => {
  const { core, local, manifest } = build((l) => { l.migrations = { rename: [{ from: 'old-extra', to: 'extra' }], delete: [] }; });
  assert.deepEqual(plan(manifest, liveFor(core, local)).rename, []);
});

test('migracja delete planuje usunięcie tylko istniejącej, wymienionej etykiety', () => {
  const { core, local, manifest } = build((l) => { l.migrations = { rename: [], delete: ['stale', 'absent'] }; });
  const live = liveFor(core, local, [{ name: 'Stale', color: 'ffffff', description: '' }, { name: 'other', color: 'ffffff', description: '' }]);
  const p = plan(manifest, live);
  assert.deepEqual(p.delete, ['Stale']);
  assert.deepEqual(p.unclassified, ['other']);
  assert.equal(pending(p), true);
});

test('plan nie zmienia danych wejściowych', () => {
  const { core, local, manifest } = build();
  const live = liveFor(core, local, [{ name: 'x', color: 'ffffff', description: '' }]);
  const before = JSON.stringify({ manifest, live });
  plan(manifest, live);
  assert.equal(JSON.stringify({ manifest, live }), before);
});
