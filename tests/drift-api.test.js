'use strict';
// Testy klienta `gh api` kontroli rozjazdu: argumenty bez powłoki, stdin, błędy, stronicowanie, ścieżki.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DriftError, makeApi, PATH } = require('../.github/standard/drift/drift_api');

function recorder(outputs) {
  const calls = [];
  const queue = Array.isArray(outputs) ? [...outputs] : null;
  const run = (args, input) => {
    calls.push({ args, input });
    const next = queue ? queue.shift() : outputs;
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, calls };
}

test('get: argumenty to tablica, odpowiedź JSON', () => {
  const { run, calls } = recorder('{"a":1}');
  assert.deepEqual(makeApi(run).get('repos/o/r'), { a: 1 });
  assert.deepEqual(calls, [{ args: ['api', 'repos/o/r'], input: undefined }]);
});

test('getAll: stronicowanie przez --paginate, jedna odpowiedź JSON na linię, puste linie pominięte', () => {
  const { run, calls } = recorder('{"n":1}\n\n{"n":2}\n  \n');
  assert.deepEqual(makeApi(run).getAll('repos/o/r/pulls?state=open&per_page=100'), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(calls[0].args, ['api', '--paginate', 'repos/o/r/pulls?state=open&per_page=100', '--jq', '.[]']);
  assert.deepEqual(makeApi(recorder('').run).getAll('repos/o/r/pulls'), []);
});

test('send: metoda, treść JSON ze stdin, odpowiedź pusta to null', () => {
  const { run, calls } = recorder(['', '{"number":3}']);
  const api = makeApi(run);
  assert.equal(api.send('POST', 'repos/o/r/statuses/abc', { state: 'pending' }), null);
  assert.deepEqual(api.send('PATCH', 'repos/o/r/issues/3', { body: 'x' }), { number: 3 });
  assert.deepEqual(calls[0], { args: ['api', '-X', 'POST', 'repos/o/r/statuses/abc', '--input', '-'], input: '{"state":"pending"}' });
  assert.equal(calls[1].args[2], 'PATCH');
});

test('błąd gh: DriftError z pierwszą linią stderr, HTTP 404 oznacza notFound, token nie trafia do komunikatu', () => {
  const boom = Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)\nszczegóły\n' });
  assert.throws(() => makeApi(recorder(boom).run).get('repos/o/r/x'), (error) => error instanceof DriftError && error.notFound === true && /^gh api repos\/o\/r\/x: gh: Not Found \(HTTP 404\)$/.test(error.message));
  const other = Object.assign(new Error('x'), { stderr: 'gh: Server Error (HTTP 502)' });
  assert.throws(() => makeApi(recorder(other).run).get('repos/o/r/x'), (error) => error.notFound === false && /502/.test(error.message));
  assert.throws(() => makeApi(recorder(new Error('spawn gh ENOENT')).run).get('repos/o/r/x'), /spawn gh ENOENT/);
  const long = Object.assign(new Error('x'), { stderr: `${'e'.repeat(500)}\n` });
  assert.throws(() => makeApi(recorder(long).run).get('repos/o/r/x'), (error) => error.message.length < 260);
});

test('odpowiedź niebędąca JSON: błąd dla get, getAll i send', () => {
  assert.throws(() => makeApi(recorder('nie json').run).get('repos/o/r'), /odpowiedź nie jest JSON/);
  assert.throws(() => makeApi(recorder('{"a":1}\nnie json').run).getAll('repos/o/r/x'), /odpowiedź nie jest JSON/);
  assert.throws(() => makeApi(recorder('nie json').run).send('POST', 'repos/o/r/x', {}), /odpowiedź nie jest JSON/);
});

test('ścieżka spoza repos/{o}/{r}/..., z opcją, spacją albo metaznakiem jest odrzucona przed wywołaniem gh', () => {
  const { run, calls } = recorder('{}');
  const api = makeApi(run);
  for (const bad of ['user', '-X', 'repos/o', 'repos/o/r/../x', 'repos/o/r/x y', 'repos/o/r/$(x)', 'repos/o/r/x;y', 'repos/o/r/x\n', '/repos/o/r', 'repos/o/r?x y', 'repos/o/r/', '--hostname=x']) {
    assert.throws(() => api.get(bad), DriftError, bad);
    assert.throws(() => api.getAll(bad), DriftError, bad);
    assert.throws(() => api.send('POST', bad, {}), DriftError, bad);
  }
  assert.equal(calls.length, 0);
  for (const good of ['repos/o/r', 'repos/o/r/issues?state=open&labels=P3,area%3Aprocess&per_page=100', 'repos/o/r/contents/.github/a%20b.js?ref=abc', 'repos/o.x/r_y-z/pulls/3/files?per_page=100']) {
    assert.ok(PATH.test(good), good);
  }
});

test('domyślny run wywołuje gh bez powłoki (execFileSync) z wejściem i buforem', () => {
  const childProcess = require('node:child_process');
  const original = childProcess.execFileSync;
  let seen;
  childProcess.execFileSync = (command, args, options) => { seen = { command, args, options }; return '{"ok":true}'; };
  try {
    assert.deepEqual(makeApi().send('POST', 'repos/o/r/issues', { a: 1 }), { ok: true });
  } finally {
    childProcess.execFileSync = original;
  }
  assert.equal(seen.command, 'gh');
  assert.deepEqual(seen.args, ['api', '-X', 'POST', 'repos/o/r/issues', '--input', '-']);
  assert.equal(seen.options.input, '{"a":1}');
  assert.equal(seen.options.encoding, 'utf8');
  assert.equal(seen.options.maxBuffer, 64 * 1024 * 1024);
  assert.deepEqual(seen.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(seen.options.shell, undefined);
});
