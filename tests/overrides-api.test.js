'use strict';
// Testy weryfikacji stanu zgłoszeń odstępstw (`common/overrides_api.js`). Sieć symulowana funkcją `getJson`
// albo lokalnym serwerem https z certyfikatem testowym. Dane syntetyczne.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const api = require('../.github/standard/common/overrides_api');
const h = require('./helpers');

const API = 'https://api.test';
const REPO = 'o/r';
const HASH = String.fromCharCode(35);
const issueRef = (repo, number) => `${repo}${HASH}${number}`;
const override = (path, number, repo = REPO, until = '2026-12-01') => ({ path, reason: 'powód', until, issue: issueRef(repo, number) });
const goodIssue = (number) => ({ number, state: 'open', labels: [{ name: 'P2' }, { name: 'audit:ok' }] });

test('issueDenial: zgłoszenie otwarte z audit:ok jest uznane', () => {
  assert.equal(api.issueDenial(goodIssue(7), 7), null);
});

test('issueDenial: każdy warunek z osobna odrzuca z własnym powodem', () => {
  const cases = [
    [{ ...goodIssue(7), number: 8 }, 'odpowiedź API dotyczy innego numeru'],
    [{ ...goodIssue(7), pull_request: {} }, 'wskazano PR, a nie zgłoszenie'],
    [{ ...goodIssue(7), pull_request: null }, 'wskazano PR, a nie zgłoszenie'],
    [{ ...goodIssue(7), state: 'closed' }, 'zgłoszenie nie jest otwarte'],
    [{ ...goodIssue(7), state: undefined }, 'zgłoszenie nie jest otwarte'],
    [{ ...goodIssue(7), labels: [{ name: 'audit:pending' }] }, 'zgłoszenie bez etykiety audit:ok'],
    [{ ...goodIssue(7), labels: [{ name: 'audit:ok2' }, { name: 'Audit:ok' }] }, 'zgłoszenie bez etykiety audit:ok'],
    [{ ...goodIssue(7), labels: [] }, 'zgłoszenie bez etykiety audit:ok'],
    [{ ...goodIssue(7), labels: 'audit:ok' }, 'zgłoszenie bez etykiety audit:ok'],
    [{ ...goodIssue(7), labels: undefined }, 'zgłoszenie bez etykiety audit:ok'],
    [{ ...goodIssue(7), labels: [null, 'audit:ok', 5] }, 'zgłoszenie bez etykiety audit:ok'],
  ];
  for (const [issue, reason] of cases) assert.equal(api.issueDenial(issue, 7), reason, JSON.stringify(issue));
});

test('issueDenial: kolejność kontroli (numer, PR, stan, etykieta)', () => {
  const all = { number: 9, pull_request: {}, state: 'closed', labels: [] };
  assert.equal(api.issueDenial(all, 7), 'odpowiedź API dotyczy innego numeru');
  assert.equal(api.issueDenial({ ...all, number: 7 }, 7), 'wskazano PR, a nie zgłoszenie');
  assert.equal(api.issueDenial({ number: 7, state: 'closed', labels: [] }, 7), 'zgłoszenie nie jest otwarte');
  assert.equal(api.issueDenial({ number: 7, state: 'open', labels: [] }, 7), 'zgłoszenie bez etykiety audit:ok');
});

test('verifyOverrides: uznanie, dokładny adres zapytania i noty', async () => {
  const urls = [];
  const getJson = async (url) => { urls.push(url); return goodIssue(12); };
  const result = await api.verifyOverrides([override('a.yml', 12)], REPO, { api: API }, getJson);
  assert.deepEqual(urls, [`${API}/repos/o/r/issues/12`]);
  assert.deepEqual([...result.approved], ['a.yml']);
  assert.deepEqual(result.notes, [`odstępstwo a.yml: uznane do 2026-12-01 (zgłoszenie ${issueRef(REPO, 12)} otwarte, audit:ok)`]);
});

test('verifyOverrides: nieuznane z powodem, bez uznania i bez błędu', async () => {
  const getJson = async () => ({ ...goodIssue(3), state: 'closed' });
  const result = await api.verifyOverrides([override('b.yml', 3)], REPO, { api: API }, getJson);
  assert.equal(result.approved.size, 0);
  assert.deepEqual(result.notes, [`odstępstwo b.yml: nieuznane: zgłoszenie nie jest otwarte (${issueRef(REPO, 3)})`]);
});

test('verifyOverrides: zgłoszenie w innym repozytorium nie jest uznane i nie wywołuje API', async () => {
  const urls = [];
  const getJson = async (url) => { urls.push(url); return goodIssue(5); };
  const result = await api.verifyOverrides([override('c.yml', 5, 'x/y')], REPO, { api: API }, getJson);
  assert.deepEqual(urls, []);
  assert.equal(result.approved.size, 0);
  assert.deepEqual(result.notes, [`odstępstwo c.yml: nieuznane: zgłoszenie ${issueRef('x/y', 5)} jest w innym repozytorium niż o/r`]);
});

test('verifyOverrides: porównanie repozytorium nie zależy od wielkości liter, a zapytanie używa nazwy kontrolowanej', async () => {
  const urls = [];
  const getJson = async (url) => { urls.push(url); return goodIssue(4); };
  const result = await api.verifyOverrides([override('d.yml', 4, 'O/R')], 'o/R', { api: API }, getJson);
  assert.deepEqual(urls, [`${API}/repos/o/R/issues/4`]);
  assert.deepEqual([...result.approved], ['d.yml']);
});

test('verifyOverrides: kilka odstępstw po kolei, uznane i nieuznane razem', async () => {
  const seen = [];
  const getJson = async (url) => {
    seen.push(url);
    return url.endsWith('/1') ? goodIssue(1) : { number: 2, state: 'open', labels: [] };
  };
  const result = await api.verifyOverrides([override('a.yml', 1), override('b.yml', 2)], REPO, { api: API }, getJson);
  assert.deepEqual(seen, [`${API}/repos/o/r/issues/1`, `${API}/repos/o/r/issues/2`]);
  assert.deepEqual([...result.approved], ['a.yml']);
  assert.equal(result.notes.length, 2);
});

test('verifyOverrides: pusta lista nie woła API', async () => {
  const result = await api.verifyOverrides([], REPO, { api: API }, async () => { throw new Error('nie wołać'); });
  assert.equal(result.approved.size, 0);
  assert.deepEqual(result.notes, []);
});

test('verifyOverrides: błąd API przerywa i nic nie jest uznane', async () => {
  const getJson = async (url) => {
    if (url.endsWith('/2')) throw new api.OverrideApiError('limit zapytań');
    return goodIssue(1);
  };
  await assert.rejects(api.verifyOverrides([override('a.yml', 1), override('b.yml', 2)], REPO, { api: API }, getJson), (error) => error instanceof api.OverrideApiError && error.message === 'limit zapytań');
});

test('verifyOverrides: zła nazwa repozytorium i zła postać zgłoszenia to błąd', async () => {
  const getJson = async () => goodIssue(1);
  for (const repo of ['', 'o', 'o/r/x', 'o r/x', undefined, 'o/r\n']) {
    await assert.rejects(api.verifyOverrides([], repo, { api: API }, getJson), { name: 'OverrideApiError', message: 'GITHUB_REPOSITORY: oczekiwano postaci wlasciciel/repo' }, String(repo));
  }
  await assert.rejects(api.verifyOverrides([{ path: 'a.yml', issue: 'to nie zgłoszenie', until: '2026-12-01' }], REPO, { api: API }, getJson),
    { name: 'OverrideApiError', message: 'odstępstwo a.yml: zła postać zgłoszenia' });
});

// ------------------------------------------------------------ makeApiGet: lokalny serwer https

async function serve(t, handler) {
  const cert = h.testCert();
  if (!cert) { t.skip('brak openssl'); return null; }
  const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: (path) => `https://localhost:${port}${path}`, port, cert: cert.cert };
}

test('makeApiGet: żądanie GET z nagłówkami, token tylko w Authorization, obiekt JSON w odpowiedzi', async (t) => {
  const seen = [];
  const server = await serve(t, (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ number: 3 }));
  });
  if (!server) return;
  const get = api.makeApiGet({ token: 'TOKEN-TESTOWY', ca: server.cert });
  assert.deepEqual(await get(server.url('/repos/o/r/issues/3')), { number: 3 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/repos/o/r/issues/3');
  assert.equal(seen[0].headers.authorization, 'Bearer TOKEN-TESTOWY');
  assert.equal(seen[0].headers.accept, 'application/vnd.github+json');
  assert.equal(seen[0].headers['x-github-api-version'], '2022-11-28');
  assert.equal(seen[0].headers['user-agent'], 'repo-standard-sync');
});

test('makeApiGet: status inny niż 200 to błąd z adresem i statusem, bez tokenu w komunikacie', async (t) => {
  const server = await serve(t, (req, res) => { res.statusCode = Number(req.url.slice(1)); res.end('{"a":1}'); });
  if (!server) return;
  const get = api.makeApiGet({ token: 'TOKEN-TESTOWY', ca: server.cert });
  for (const status of [201, 204, 403, 404, 500]) {
    await assert.rejects(get(server.url(`/${status}`)), (error) => {
      assert.equal(error.name, 'OverrideApiError');
      assert.equal(error.message, `${server.url(`/${status}`)}: status ${status}`);
      assert.ok(!error.message.includes('TOKEN-TESTOWY'));
      return true;
    });
  }
});

test('makeApiGet: przekierowanie nie jest śledzone, a token nie idzie dalej', async (t) => {
  const other = [];
  const target = await serve(t, (req, res) => { other.push(req.headers.authorization); res.end('{"a":1}'); });
  if (!target) return;
  const server = await serve(t, (req, res) => { res.statusCode = 301; res.setHeader('Location', target.url('/x')); res.end(); });
  const get = api.makeApiGet({ token: 'TOKEN-TESTOWY', ca: server.cert });
  await assert.rejects(get(server.url('/r')), /status 301/);
  assert.deepEqual(other, []);
});

test('makeApiGet: odpowiedź niebędąca obiektem JSON to błąd', async (t) => {
  const bodies = { '/nie-json': 'to nie json', '/tablica': '[1,2]', '/liczba': '5', '/null': 'null', '/napis': '"x"' };
  const server = await serve(t, (req, res) => res.end(bodies[req.url]));
  if (!server) return;
  const get = api.makeApiGet({ token: 't', ca: server.cert });
  await assert.rejects(get(server.url('/nie-json')), { message: `${server.url('/nie-json')}: odpowiedź nie jest JSON` });
  for (const path of ['/tablica', '/liczba', '/null', '/napis']) {
    await assert.rejects(get(server.url(path)), { message: `${server.url(path)}: oczekiwano obiektu JSON` }, path);
  }
});

test('makeApiGet: odpowiedź większa niż limit jest odrzucona, równa limitowi przechodzi', async (t) => {
  const server = await serve(t, (req, res) => {
    const pad = req.url === '/duza' ? api.MAX_BODY + 1 : api.MAX_BODY;
    const head = '{"a":"';
    const tail = '"}';
    res.end(head + 'x'.repeat(pad - head.length - tail.length) + tail);
  });
  if (!server) return;
  const get = api.makeApiGet({ token: 't', ca: server.cert });
  await assert.rejects(get(server.url('/duza')), { name: 'OverrideApiError', message: `${server.url('/duza')}: odpowiedź większa niż ${api.MAX_BODY} bajtów` });
  const ok = await get(server.url('/rowna'));
  assert.equal(ok.a.length, api.MAX_BODY - 8);
});

test('makeApiGet: brak odpowiedzi w czasie to błąd z limitem', async (t) => {
  const server = await serve(t, () => {});
  if (!server) return;
  const get = api.makeApiGet({ token: 't', ca: server.cert, timeoutMs: 150 });
  await assert.rejects(get(server.url('/wisi')), { name: 'OverrideApiError', message: `${server.url('/wisi')}: przekroczono czas 150 ms` });
});

test('makeApiGet: domyślny limit czasu to 15 s (zapisany w opcjach żądania)', async (t) => {
  const server = await serve(t, (req, res) => res.end('{}'));
  if (!server) return;
  const original = https.request;
  let options;
  https.request = (url, opts, cb) => { options = opts; return original(url, opts, cb); };
  t.after(() => { https.request = original; });
  await api.makeApiGet({ token: 't', ca: server.cert })(server.url('/'));
  assert.equal(options.timeout, 15000);
});

test('makeApiGet: błąd połączenia, zły adres i http to OverrideApiError', async (t) => {
  const server = await serve(t, (req, res) => res.end('{}'));
  if (!server) return;
  const get = api.makeApiGet({ token: 't', ca: server.cert });
  await assert.rejects(get('https://localhost:1/x'), (error) => error.name === 'OverrideApiError' && error.message.startsWith('zapytanie https://localhost:1/x: '));
  await assert.rejects(get('nie adres'), { name: 'OverrideApiError', message: 'zły adres API: nie adres' });
  await assert.rejects(get('http://localhost:1/x'), { name: 'OverrideApiError', message: 'API tylko przez https: http://localhost:1/x' });
});

test('makeApiGet: niezaufany certyfikat to błąd, nie wynik', async (t) => {
  const server = await serve(t, (req, res) => res.end('{}'));
  if (!server) return;
  const get = api.makeApiGet({ token: 't' });
  await assert.rejects(get(server.url('/')), { name: 'OverrideApiError' });
});

test('issueDenial: etykiety nietypowe (null, nie-tablica, napis) nie rzucają i nie dają uznania', () => {
  const issue = (labels) => ({ number: 1, state: 'open', labels });
  assert.equal(api.issueDenial(issue([null, { name: 'audit:ok' }]), 1), null, 'null przed właściwą etykietą nie przerywa');
  assert.equal(api.issueDenial(issue([null]), 1), 'zgłoszenie bez etykiety audit:ok');
  for (const labels of ['audit:ok', { name: 'audit:ok' }, 5, undefined, [{ name: 'audit:okx' }], ['audit:ok']]) {
    assert.equal(api.issueDenial(issue(labels), 1), 'zgłoszenie bez etykiety audit:ok', JSON.stringify(labels));
  }
});

test('verifyOverrides: nazwy repozytorium i zgłoszenia są sprawdzane w całości (kotwice, wielu znaków)', async () => {
  const urls = [];
  const getJson = async (url) => { urls.push(url); return goodIssue(12); };
  const repo = 'owner-x/repo.y_z';
  const result = await api.verifyOverrides([override('a.yml', 12, repo)], repo, { api: API }, getJson);
  assert.deepEqual([...result.approved], ['a.yml']);
  assert.deepEqual(urls, [`${API}/repos/${repo}/issues/12`]);
  for (const bad of [`x ${issueRef(REPO, 1)}`, `${issueRef(REPO, 1)}abc`, `${issueRef(REPO, 1)} `, `${issueRef('ab/c', 1)}${HASH}2`, issueRef('o/r', 0), issueRef('o/r', '01')]) {
    await assert.rejects(api.verifyOverrides([{ path: 'a.yml', issue: bad, until: '2026-12-01' }], REPO, { api: API }, getJson), { message: 'odstępstwo a.yml: zła postać zgłoszenia' }, bad);
  }
  for (const badRepo of ['a/', '/b', 'ab/c d', 'a/bc\n']) {
    await assert.rejects(api.verifyOverrides([], badRepo, { api: API }, getJson), { message: 'GITHUB_REPOSITORY: oczekiwano postaci wlasciciel/repo' }, badRepo);
  }
  assert.equal((await api.verifyOverrides([], 'ab/cd', { api: API }, getJson)).approved.size, 0, 'wieloznakowe nazwy po obu stronach ukośnika są poprawne');
});

test('makeApiGet: odpowiedź z błędem statusu jest odczytana do końca, a przerwana odpowiedź 200 to błąd', async (t) => {
  let finished = 0;
  const server = await serve(t, (req, res) => {
    if (req.url === '/big') {
      res.statusCode = 500;
      res.on('finish', () => { finished += 1; });
      return res.end(Buffer.alloc(30000, 120));
    }
    res.statusCode = 200;
    res.setHeader('content-length', '1000');
    res.write('{"a":');
    setTimeout(() => req.socket.destroy(), 20);
  });
  if (!server) return;
  const get = api.makeApiGet({ token: 'T', ca: server.cert, timeoutMs: 5000 });
  await assert.rejects(get(server.url('/big')), /status 500/);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(finished, 1);
  const busy = Object.values(https.globalAgent.sockets).reduce((sum, list) => sum + list.length, 0);
  assert.equal(busy, 0, 'gniazdo zwolnione po odczycie ciała odpowiedzi (response.resume)');
  await assert.rejects(get(server.url('/cut')), (error) => error.name === 'OverrideApiError' && !/przekroczono czas/.test(error.message));
});
