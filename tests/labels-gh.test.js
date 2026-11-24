'use strict';
// Klient `gh api`: dokładne argumenty odczytu i zapisu, parsowanie, błędy narzędzia. Bez sieci i bez `gh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { ghClient, main } = require('../.github/standard/labels/labels_sync');

const recorder = (answer = '') => {
  const calls = [];
  return { calls, run: (args) => { calls.push(args); return typeof answer === 'function' ? answer(args) : answer; } };
};

test('listLabels: stronicowany odczyt, opis null to pusty napis, puste linie pomijane', () => {
  const { calls, run } = recorder('{"name":"P0","color":"b60205","description":"x"}\n\n{"name":"bug","color":"d73a4a","description":null}\n');
  const labels = ghClient('o/r', run).listLabels();
  assert.deepEqual(calls, [['api', '--paginate', 'repos/o/r/labels?per_page=100', '--jq', '.[] | {name, color, description}']]);
  assert.deepEqual(labels, [{ name: 'P0', color: 'b60205', description: 'x' }, { name: 'bug', color: 'd73a4a', description: '' }]);
});

test('usage: liczy numery zgłoszeń i PR ze wszystkich stron, stan all, nazwa zakodowana', () => {
  const { calls, run } = recorder('1\n2\n  \n30\n');
  assert.equal(ghClient('o/r', run).usage('area:x y'), 3);
  assert.deepEqual(calls, [['api', '--paginate', 'repos/o/r/issues?labels=area%3Ax%20y&state=all&per_page=100', '--jq', '.[].number']]);
  assert.equal(ghClient('o/r', () => '').usage('a'), 0);
});

test('create, update, rename, remove: metoda, ścieżka z zakodowaną nazwą i pola', () => {
  const { calls, run } = recorder();
  const client = ghClient('o/r', run);
  const label = { name: 'area:new', color: 'AABBCC', description: 'Opis.' };
  client.create(label);
  client.update('area:old', label);
  client.rename('area:old', 'area:new');
  client.remove('area:old');
  assert.deepEqual(calls, [
    ['api', '-X', 'POST', 'repos/o/r/labels', '-f', 'name=area:new', '-f', 'color=AABBCC', '-f', 'description=Opis.'],
    ['api', '-X', 'PATCH', 'repos/o/r/labels/area%3Aold', '-f', 'new_name=area:new', '-f', 'color=AABBCC', '-f', 'description=Opis.'],
    ['api', '-X', 'PATCH', 'repos/o/r/labels/area%3Aold', '-f', 'new_name=area:new'],
    ['api', '-X', 'DELETE', 'repos/o/r/labels/area%3Aold']
  ]);
});

test('błąd narzędzia gh: kod 2, pierwsza linia stderr, bez wycieku reszty', () => {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw Object.assign(new Error('Command failed'), { stderr: 'gh: HTTP 403 Forbidden\nsekretna druga linia' }); };
  try {
    const err = [];
    const code = main(['--repo', 'CityCouriers/repo-standard', 'diff'], { env: {}, out: { log() {} }, err: { error: (m) => err.push(m) } });
    assert.equal(code, 2);
    assert.equal(err.join('\n'), 'labels_sync: gh api --paginate repos/CityCouriers/repo-standard/labels?per_page=100: gh: HTTP 403 Forbidden');
  } finally {
    childProcess.execFileSync = original;
  }
});

test('wywołanie gh: argumenty bez powłoki, kodowanie utf8 i duży bufor', () => {
  const original = childProcess.execFileSync;
  const seen = [];
  childProcess.execFileSync = (...args) => { seen.push(args); return ''; };
  try {
    ghClient('o/r').listLabels();
  } finally {
    childProcess.execFileSync = original;
  }
  assert.equal(seen[0][0], 'gh');
  assert.deepEqual(seen[0][2], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
});

test('błąd narzędzia bez stderr używa komunikatu błędu', () => {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw new Error('spawn gh ENOENT'); };
  try {
    const err = [];
    main(['--repo', 'CityCouriers/repo-standard', 'diff'], { env: {}, out: { log() {} }, err: { error: (m) => err.push(m) } });
    assert.match(err[0], /spawn gh ENOENT/);
  } finally {
    childProcess.execFileSync = original;
  }
});
