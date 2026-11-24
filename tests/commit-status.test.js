'use strict';
// Testy wspólnego mechanizmu commit status (kontrakt dla kontroli wymaganych na HEAD PR) z własnym kontekstem.

const test = require('node:test');
const assert = require('node:assert/strict');
const cs = require('../.github/standard/drift/commit_status');
const { DriftError } = require('../.github/standard/drift/drift_api');
const h = require('./helpers');
const f = require('./drift-fake');

const CTX = 'secret-scan-head';
const HEAD = h.fakeSha('cs-head');
const prs = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { head: h.fakeSha(`cs${i + 1}`), tree: {}, files: [] }]));

test('setStatus: POST na SHA z podanym kontekstem, opis oczyszczony i przycięty', () => {
  const gh = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] } } });
  cs.setStatus(gh.api, f.REPO, HEAD, CTX, 'success', `a\n${'b'.repeat(200)}`);
  assert.deepEqual(gh.log, [`POST repos/o/r/statuses/${HEAD}`]);
  assert.equal(gh.statuses[0].context, CTX);
  assert.equal(gh.statuses[0].state, 'success');
  assert.equal(gh.statuses[0].description.length, 140);
  assert.ok(!gh.statuses[0].description.includes('\n'));
});

test('readPrHead: pełny SHA z API; brak lub zły SHA to błąd', () => {
  const gh = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] }, 2: { head: 'abc', tree: {}, files: [] } } });
  assert.equal(cs.readPrHead(gh.api, f.REPO, 1), HEAD);
  assert.throws(() => cs.readPrHead(gh.api, f.REPO, 2), /PR 2: HEAD: oczekiwano pełnego SHA/);
  assert.throws(() => cs.readPrHead({ get: () => null }, f.REPO, 3), /PR 3: HEAD: oczekiwano pełnego SHA/);
  assert.throws(() => cs.validSha(5, 'x'), DriftError);
  assert.throws(() => cs.validSha(HEAD.toUpperCase(), 'x'), DriftError);
  assert.equal(cs.validSha(HEAD, 'x'), HEAD);
});

test('guardedResult: pending, obliczenie, zapis wyniku z podanym kontekstem', async () => {
  const gh = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] } } });
  const outcome = await cs.guardedResult(gh.api, f.REPO, 1, HEAD, CTX, async () => ({ state: 'success', description: 'ok', lines: [], code: 0 }), { announce: 'w toku' });
  assert.equal(outcome.written, true);
  assert.equal(outcome.current, HEAD);
  assert.deepEqual(gh.statuses.map((s) => [s.context, s.state, s.description]), [[CTX, 'pending', 'w toku'], [CTX, 'success', 'ok']]);
});

test('guardedResult: bez announce nie ma pending; wyjątek obliczeń to failure z kodem 2, nigdy success', async () => {
  const gh = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] } } });
  const outcome = await cs.guardedResult(gh.api, f.REPO, 1, HEAD, CTX, async () => { throw new Error('pad\nsieci'); });
  assert.equal(outcome.written, true);
  assert.equal(outcome.result.code, 2);
  assert.equal(outcome.result.state, 'failure');
  assert.deepEqual(outcome.result.lines, ['Error: pad\nsieci']);
  assert.deepEqual(gh.statuses.map((s) => [s.state, s.description]), [['failure', 'błąd działania: pad sieci']]);
});

test('guardedResult: HEAD zmieniony w trakcie obliczeń: brak zapisu wyniku, zostaje pending', async () => {
  const NEW = h.fakeSha('cs-new');
  const gh = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] } } });
  const outcome = await cs.guardedResult(gh.api, f.REPO, 1, HEAD, CTX, async () => { gh.state.prs[1].head = NEW; return { state: 'success', description: 'ok', lines: [], code: 0 }; }, { announce: 'x' });
  assert.equal(outcome.written, false);
  assert.equal(outcome.current, NEW);
  assert.deepEqual(gh.statuses.map((s) => s.state), ['pending']);
});

test('guardedResult: błąd zapisu wyniku albo odczytu HEAD przechodzi do wywołującego', async () => {
  const gh = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] } }, hooks: { onSend: (m, p, body) => { if (body.state === 'success') throw new DriftError('HTTP 403'); } } });
  await assert.rejects(cs.guardedResult(gh.api, f.REPO, 1, HEAD, CTX, async () => ({ state: 'success', description: 'ok', lines: [], code: 0 })), /HTTP 403/);
  const broken = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] } }, hooks: { onGet: (p) => { if (p.endsWith('/pulls/1')) throw new DriftError('HTTP 502'); } } });
  await assert.rejects(cs.guardedResult(broken.api, f.REPO, 1, HEAD, CTX, async () => ({ state: 'success', description: 'ok', lines: [], code: 0 })), /HTTP 502/);
  assert.deepEqual(broken.statuses, []);
});

test('reconcileOpenPrs: pending na wszystkich przed pierwszym przeliczeniem, limit, reszta pending', async () => {
  const gh = f.fakeGitHub({ prs: prs(5) });
  const order = [];
  const outcome = await cs.reconcileOpenPrs(gh.api, f.REPO, 'main', CTX, 'przeliczanie', async (n) => { order.push([n, gh.statuses.length]); return 0; }, { maxRecalc: 3 });
  assert.deepEqual(outcome, { code: 0, lines: [], open: 5, recomputed: 3, skipped: 2 });
  assert.deepEqual(order, [[1, 5], [2, 5], [3, 5]]);
  assert.equal(gh.statuses.every((s) => s.state === 'pending' && s.context === CTX && s.description === 'przeliczanie'), true);
  assert.ok(gh.log.includes('GETALL repos/o/r/pulls?state=open&base=main&per_page=100'));
});

test('reconcileOpenPrs: domyślny limit 25; kody 1 z przeliczenia nie czerwienią, kod 2 tak', async () => {
  const gh = f.fakeGitHub({ prs: prs(27) });
  const seen = [];
  const outcome = await cs.reconcileOpenPrs(gh.api, f.REPO, 'main', CTX, 'x', async (n) => { seen.push(n); return n === 2 ? 1 : 0; });
  assert.equal(outcome.recomputed, 25);
  assert.equal(outcome.skipped, 2);
  assert.equal(outcome.code, 0);
  const gh2 = f.fakeGitHub({ prs: prs(2) });
  assert.equal((await cs.reconcileOpenPrs(gh2.api, f.REPO, 'main', CTX, 'x', async (n) => (n === 2 ? 2 : 0))).code, 2);
});

test('reconcileOpenPrs: błąd pending jednego PR i wyjątek przeliczenia: kod 2, komunikaty, reszta obsłużona', async () => {
  const bad = h.fakeSha('cs2');
  const gh = f.fakeGitHub({ prs: prs(3), hooks: { onSend: (m, p) => { if (p.endsWith(bad)) throw new DriftError('HTTP 403'); } } });
  const done = [];
  const outcome = await cs.reconcileOpenPrs(gh.api, f.REPO, 'main', CTX, 'x', async (n) => { done.push(n); if (n === 3) throw new Error('boom'); return 0; });
  assert.equal(outcome.code, 2);
  assert.deepEqual(outcome.lines, ['PR 2: nie ustawiono pending: HTTP 403', 'PR 3: przeliczenie nie powiodło się, zostaje pending: boom']);
  assert.deepEqual(done, [1, 3]);
  assert.equal(outcome.recomputed, 2);
  assert.equal(outcome.skipped, 0);
  const noHead = await cs.reconcileOpenPrs({ getAll: () => [{ number: 9, head: { sha: 'zly' } }, { number: 4 }], send() {} }, f.REPO, 'main', CTX, 'x', async () => 0);
  assert.equal(noHead.code, 2);
  assert.equal(noHead.lines[0], 'PR 9: nie ustawiono pending: PR 9: HEAD: oczekiwano pełnego SHA');
  assert.match(noHead.lines[1], /^PR 4: nie ustawiono pending: /);
  assert.equal(noHead.lines.length, 2);
  await assert.rejects(cs.reconcileOpenPrs({ getAll: () => [null], send() {} }, f.REPO, 'main', CTX, 'x', async () => 0), TypeError);
});

test('reconcileOpenPrs: gałąź w zapytaniu jest zakodowana', async () => {
  const seen = [];
  await cs.reconcileOpenPrs({ getAll: (p) => { seen.push(p); return []; }, send() {} }, f.REPO, 'a b/c', CTX, 'x', async () => 0);
  assert.deepEqual(seen, ['repos/o/r/pulls?state=open&base=a%20b%2Fc&per_page=100']);
});

test('guardedResult: isCurrent false (baza przesunięta): brak zapisu wyniku, stale true, zostaje pending', async () => {
  const gh = f.fakeGitHub({ prs: { 1: { head: HEAD, tree: {}, files: [] } } });
  const outcome = await cs.guardedResult(gh.api, f.REPO, 1, HEAD, CTX, async () => ({ state: 'success', description: 'ok', lines: [], code: 0 }), { announce: 'x', isCurrent: () => false });
  assert.equal(outcome.written, false);
  assert.equal(outcome.stale, true);
  assert.deepEqual(gh.statuses.map((s) => s.state), ['pending']);
  const fresh = await cs.guardedResult(gh.api, f.REPO, 1, HEAD, CTX, async () => ({ state: 'success', description: 'ok', lines: [], code: 0 }), { isCurrent: () => true });
  assert.equal(fresh.written, true);
  assert.equal(fresh.stale, false);
});

test('guardedResult: zmieniony HEAD ma pierwszeństwo przed bazą: stale false', async () => {
  const gh = f.fakeGitHub({ prs: { 1: { head: h.fakeSha('inny'), tree: {}, files: [] } } });
  const outcome = await cs.guardedResult(gh.api, f.REPO, 1, HEAD, CTX, async () => ({ state: 'success', description: 'ok', lines: [], code: 0 }), { isCurrent: () => false });
  assert.equal(outcome.written, false);
  assert.equal(outcome.stale, false);
});
