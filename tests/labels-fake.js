'use strict';
// Wspólne narzędzia testów etykiet: dane syntetyczne, atrapa klienta GitHub, przechwycenie wyjścia.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers');

const CORE_FILE = path.join(REPO_ROOT, '.github', 'standard', 'labels', 'labels-core.json');
const LOCAL_FILE = path.join(REPO_ROOT, '.github', 'labels.json');
const REPO = 'CityCouriers/repo-standard';

const CORE_NAMES = ['P0', 'P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3', 'blocked', 'needs-triage', 'by:agent', 'audit:pending', 'audit:changes', 'audit:ok'];

const clone = (value) => JSON.parse(JSON.stringify(value));
const readCore = () => clone(JSON.parse(fs.readFileSync(CORE_FILE, 'utf8')));
const readLocal = () => clone(JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')));

/** Plik lokalny syntetyczny, niezależny od prawdziwego: dwie etykiety `area:` i jedna cudza. */
function syntheticLocal(overrides = {}) {
  return {
    schema: 1,
    repo: 'owner/repo',
    families: { area: { prefix: 'area:', color: '0E8A16' }, misc: {} },
    labels: [
      { name: 'area:one', color: '0E8A16', family: 'area', description: 'Pierwszy obszar.' },
      { name: 'area:two', color: '0E8A16', family: 'area', description: 'Drugi obszar.' },
      { name: 'extra', color: 'AAAAAA', family: 'misc', description: 'Etykieta lokalna.' }
    ],
    system: ['bug'],
    foreign: ['vendor'],
    migrations: { rename: [], delete: [] },
    ...overrides
  };
}

/** Stan repozytorium zgodny z manifestem (rdzeń i etykiety lokalne), plus ewentualne dodatki. */
function liveFor(core, local, extra = []) {
  const managed = [...core.labels, ...local.labels].map((l) => ({ name: l.name, color: l.color.toLowerCase(), description: l.description }));
  return [...managed, ...extra];
}

/**
 * Atrapa klienta: `state` to lista etykiet, `uses` mapa nazwa -> liczba użyć. `failOn` to lista "operacja:nazwa",
 * które rzucają błąd (np. "create:area:one"); `staleAfterWrites` podstawia po zapisie stan sprzed zmian.
 */
function fakeClient(state, { uses = {}, failOn = [], stale = false, list = null } = {}) {
  const calls = [];
  const labels = state.map((l) => ({ ...l }));
  const initial = state.map((l) => ({ ...l }));
  const find = (name) => labels.findIndex((l) => l.name.toLowerCase() === name.toLowerCase());
  const guard = (op, name) => {
    calls.push(`${op}:${name}`);
    if (failOn.includes(`${op}:${name}`)) throw new Error(`atrapa: ${op} ${name} odrzucone (429)`);
  };
  let writes = 0;
  return {
    calls,
    labels,
    get writes() { return writes; },
    listLabels() {
      calls.push('list');
      if (list) return list(calls.filter((c) => c === 'list').length);
      return (stale && writes > 0 ? initial : labels).map((l) => ({ ...l }));
    },
    usage(name) { calls.push(`usage:${name}`); return uses[name] || 0; },
    create(label) { guard('create', label.name); writes += 1; labels.push({ name: label.name, color: label.color.toLowerCase(), description: label.description }); },
    update(name, label) {
      const current = labels[find(name)];
      const noop = current.name === label.name && current.color.toLowerCase() === label.color.toLowerCase() && current.description === label.description;
      guard(noop ? 'probe' : 'update', name);
      if (!noop) writes += 1;
      labels[find(name)] = { name: label.name, color: label.color.toLowerCase(), description: label.description };
    },
    rename(name, to) { guard('rename', name); writes += 1; labels[find(name)].name = to; },
    remove(name) { guard('delete', name); writes += 1; labels.splice(find(name), 1); }
  };
}

/** Uruchamia `main` z wstrzykniętymi plikami (obiekty JSON) i klientem; zwraca kod, wyjście i błędy. */
function runMain(argv, { core = readCore(), local = syntheticLocal(), client, env = {}, files = {}, run = () => { throw new Error('gh wywołane w teście bez atrapy run'); } } = {}) {
  const out = [];
  const err = [];
  const contents = { 'core.json': JSON.stringify(core), ...(local === null ? {} : { 'local.json': JSON.stringify(local) }), ...files };
  const code = require('../.github/standard/labels/labels_sync').main(['--core', 'core.json', '--local', 'local.json', ...argv], {
    out: { log: (line) => out.push(line) },
    err: { error: (line) => err.push(line) },
    env,
    readFile: (file) => {
      if (!(file in contents)) throw Object.assign(new Error('brak'), { code: 'ENOENT' });
      return contents[file];
    },
    client,
    run
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

module.exports = { CORE_FILE, LOCAL_FILE, REPO, CORE_NAMES, clone, readCore, readLocal, syntheticLocal, liveFor, fakeClient, runMain };
