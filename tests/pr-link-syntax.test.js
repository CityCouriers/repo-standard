'use strict';
// Parser składni powiązania PR ze zgłoszeniem: wspólne przypadki (cases.json), dokładne komunikaty i granice.
// Dane wyłącznie syntetyczne. Znak hash w odwołaniach z repozytorium składany w kodzie, żeby dane nie wyglądały
// jak odwołanie do cudzego zgłoszenia.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const syntax = require('../.github/standard/pr-link/pr_link_syntax');
const { REPO_ROOT } = require('./helpers');

const { parse, titleErrors } = syntax;
const H = '#';
const HOST = ['github', 'com'].join('.');
const FIRST_LINE_ERROR = 'pierwsza linia opisu musi mieć postać `Fixes #<n>` albo `Refs #<n>` '
  + '(dokładnie, bez dwukropka i dopisków, jedno zgłoszenie, liczba bez zer wiodących)';
const CLOSING_ERROR = (n) => `linia ${n}: słowo zamykające z odwołaniem do zgłoszenia (dozwolone tylko Fixes w pierwszej linii)`;
const SECOND_ERROR = (n) => `linia ${n}: drugie powiązanie ze zgłoszeniem (jeden PR, jedno zgłoszenie)`;
const TITLE_ERROR = 'tytuł PR zawiera słowo zamykające z odwołaniem do zgłoszenia';

const cases = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github/standard/pr-link/cases.json'), 'utf8'));

test('wspólne przypadki: opis (valid = brak błędów; kind i issue dla poprawnych)', () => {
  assert.ok(cases.body.length >= 60);
  for (const item of cases.body) {
    const result = parse(item.body);
    assert.equal(result.errors.length === 0, item.valid, item.name);
    if (item.valid) {
      assert.equal(result.kind, item.kind, item.name);
      assert.equal(result.issue, item.issue, item.name);
    }
  }
});

test('wspólne przypadki: tytuł', () => {
  assert.ok(cases.title.length >= 10);
  for (const item of cases.title) {
    assert.equal(titleErrors(item.title).length === 0, item.valid, item.name);
  }
});

test('wspólne przypadki mają unikalne nazwy i obie klasy wyników', () => {
  const names = cases.body.map((item) => item.name).concat(cases.title.map((item) => item.name));
  assert.equal(new Set(names).size, names.length);
  assert.ok(cases.body.some((item) => item.valid) && cases.body.some((item) => !item.valid));
  assert.ok(cases.title.some((item) => item.valid) && cases.title.some((item) => !item.valid));
  assert.equal(cases.schema, 1);
});

test('poprawna pierwsza linia: dokładny wynik', () => {
  assert.deepEqual(parse('Fixes #12'), { kind: 'Fixes', issue: 12, errors: [] });
  assert.deepEqual(parse('Refs #7'), { kind: 'Refs', issue: 7, errors: [] });
  assert.deepEqual(parse('Refs #123456789\nreszta'), { kind: 'Refs', issue: 123456789, errors: [] });
  assert.deepEqual(parse('\uFEFFFixes #12\r\nreszta\r\n'), { kind: 'Fixes', issue: 12, errors: [] });
  assert.deepEqual(parse('Fixes #12 \t \nreszta'), { kind: 'Fixes', issue: 12, errors: [] });
});

test('liczba w pierwszej linii: granice', () => {
  for (const good of ['1', '9', '10', '19', '90', '99', '100', '12345678', '123456789']) {
    assert.deepEqual(parse(`Fixes ${H}${good}`).errors, [], good);
  }
  for (const bad of ['0', '00', '01', '012', '1234567890', '12345678901234567890', '-1', '1.5', '1a', 'a1']) {
    assert.deepEqual(parse(`Fixes ${H}${bad}`).errors, [FIRST_LINE_ERROR], bad);
  }
});

test('niepoprawna pierwsza linia: kind i issue puste, jeden błąd z komunikatem', () => {
  for (const body of ['', 'Fixes: #12', 'fixes #12', 'Fixes #<nr>', 'Fixes #', 'Fixes', 'Fixes 12', 'Closes #12']) {
    assert.deepEqual(parse(body), { kind: null, issue: null, errors: [FIRST_LINE_ERROR] }, body);
  }
});

test('pierwsza linia musi być całą linią: przed słowem, po numerze, rodzaj odstępu', () => {
  for (const body of [' Fixes #12', '\tFixes #12', 'x Fixes #12', 'Fixes  #12', 'Fixes\t#12', 'Fixes\u00A0#12', 'Fixes #12\u00A0',
    'Fixes #12.', 'Fixes #12,', 'Fixes #12 x', 'Fixes #12 #13', 'Fixes #12\u200B', 'FixesFixes #12', 'Fixes #12Fixes #12',
    '\uFEFF\uFEFFFixes #12', 'Fixes #12\r', 'Fixes #12\rx', '**Fixes** #12', '`Fixes #12`']) {
    assert.deepEqual(parse(body).errors, [FIRST_LINE_ERROR], JSON.stringify(body));
  }
});

test('końce linii: LF i CRLF równoważne, numer kolejnej linii liczony od jedynki', () => {
  const lf = parse('Fixes #12\nnic\nCloses #9\nRefs #3');
  const crlf = parse('Fixes #12\r\nnic\r\nCloses #9\r\nRefs #3');
  assert.deepEqual(lf, { kind: 'Fixes', issue: 12, errors: [CLOSING_ERROR(3), SECOND_ERROR(4)] });
  assert.deepEqual(crlf, lf);
  assert.deepEqual(parse('Fixes #12\nCloses #9').errors, [CLOSING_ERROR(2)]);
});

test('błędy pierwszej i dalszych linii są zbierane razem, pierwszy jest błędem pierwszej linii', () => {
  assert.deepEqual(parse('Treść\nCloses #9'), { kind: null, issue: null, errors: [FIRST_LINE_ERROR, CLOSING_ERROR(2)] });
  assert.deepEqual(parse('Fixes #12\nRefs #3\nFixes #4'), { kind: 'Fixes', issue: 12, errors: [SECOND_ERROR(2), CLOSING_ERROR(3)] });
});

test('słowa zamykające: wszystkie odmiany, wielkość liter, dwukropek, rodzaj odstępu i odwołania', () => {
  const words = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
  const refs = [`${H}9`, 'GH-9', `owner/repo${H}9`, `https://${HOST}/owner/repo/issues/9`, `a.b-c_d/e.f-g_h${H}9`];
  for (const word of words) {
    const forms = [word, word[0].toUpperCase() + word.slice(1), word.toUpperCase()];
    for (const form of forms) {
      for (const ref of refs) {
        for (const sep of [' ', ':  ', ': ', '\t']) {
          assert.deepEqual(parse(`Fixes ${H}12\n${form}${sep}${ref}`).errors, [CLOSING_ERROR(2)], `${form}${sep}${ref}`);
        }
      }
    }
  }
});

test('słowa zamykające: w środku linii, po znakach niebędących literami, w komentarzu HTML', () => {
  for (const line of ['Przy okazji resolves #5.', '(closes #5)', 'a, fixed #5', '- fix #5', '> Closes #5', '<!-- Closes #5 -->',
    'tekst <!-- resolved: #5 --> tekst', 'x\u00A0Fixes #5']) {
    assert.deepEqual(parse(`Fixes ${H}12\n${line}`).errors, [CLOSING_ERROR(2)], line);
  }
});

test('nie są słowami zamykającymi: brak odwołania, inne słowa, brak odstępu', () => {
  for (const line of ['Naprawa fix w parserze', 'resolved bez numeru', 'prefix #5', 'suffix #6', 'unfixed #5', 'fixing #5', 'closer #5',
    'resolver #5', 'enclose #5', 'disclosed #5', 'fixes#5', 'fixes: x', 'fix #', 'fix #a', 'closes GH-', 'closes gh-x', 'closes /#5',
    'closes owner/repo#', `closes https://${HOST}/o/r/pull/5`, 'closes http://example.com/o/r/issues/5', 'close\n#5', '#5 closes',
    'Fixes #<nr>', 'Refs #<nr>', 'Fixes #n albo Refs #n', 'fixes (#5)', 'fixes **#5**']) {
    assert.deepEqual(parse(`Fixes ${H}12\n${line}`).errors, [], line);
  }
});

test('odwołanie z adresem: tylko github.com i tylko zgłoszenia', () => {
  assert.deepEqual(parse(`Fixes ${H}12\ncloses http://${HOST}/o/r/issues/5`).errors, [CLOSING_ERROR(2)]);
  assert.deepEqual(parse(`Fixes ${H}12\ncloses https://${HOST}/o/r/issues/5`).errors, [CLOSING_ERROR(2)]);
  assert.deepEqual(parse(`Fixes ${H}12\ncloses https://githubXcom/o/r/issues/5`).errors, []);
  assert.deepEqual(parse(`Fixes ${H}12\ncloses https://github.com/o/issues/5`).errors, []);
  assert.deepEqual(parse(`Fixes ${H}12\ncloses https://github.com/o/r/issues/x`).errors, []);
});

test('drugie Refs: początek dalszej linii, z wcięciem i dwukropkiem; w środku linii nie', () => {
  for (const line of [`Refs ${H}3`, `refs ${H}3`, `REFS ${H}3`, `Ref ${H}3`, `Refs${H}3`, `Refs: ${H}3`, `Refs:${H}3`, `  Refs ${H}3`,
    `\tRefs ${H}3`, `Refs   ${H}3`, `Refs\t${H}3`, `Refs ${H}3 dopisek`]) {
    assert.deepEqual(parse(`Fixes ${H}12\n${line}`).errors, [SECOND_ERROR(2)], line);
  }
  for (const line of [`zob. Refs ${H}3`, `Refs x${H}3`, `Refs ${H}n`, `Refs ${H}<nr>`, `Refsx ${H}3`, `Referencja ${H}3`, `- Refs ${H}3`, `prefs ${H}3`]) {
    assert.deepEqual(parse(`Fixes ${H}12\n${line}`).errors, [], line);
  }
});

test('jedna linia z dwoma naruszeniami daje jeden błąd (słowo zamykające ma pierwszeństwo)', () => {
  assert.deepEqual(parse(`Fixes ${H}12\nRefs ${H}3 oraz closes ${H}4`).errors, [CLOSING_ERROR(2)]);
  assert.deepEqual(parse(`Fixes ${H}12\nfixes ${H}3`).errors, [CLOSING_ERROR(2)]);
});

test('wejście nie będące tekstem: wynik czerwony, bez wyjątku', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.deepEqual(parse(value), { kind: null, issue: null, errors: ['opis PR nie jest tekstem'] });
    assert.deepEqual(titleErrors(value), ['tytuł PR nie jest tekstem']);
  }
});

test('tytuł: słowo zamykające z odwołaniem to błąd, reszta nie', () => {
  for (const title of [`Closes ${H}9`, `fix: fixes ${H}9 w bramce`, 'feat: resolves GH-3', `Fixes: ${H}9`, `Fixes owner/repo${H}9`,
    `closed https://${HOST}/o/r/issues/9`, `RESOLVED ${H}5`, `a (closed ${H}5)`]) {
    assert.deepEqual(titleErrors(title), [TITLE_ERROR], title);
  }
  for (const title of ['', 'feat: ujednolicenie powiązania', 'fix: naprawa parsera', `chore: prefix ${H}12`, 'docs: Refs i Fixes', `Refs ${H}12`]) {
    assert.deepEqual(titleErrors(title), [], title);
  }
});

test('granica parser i kontrola PR: parse dostaje wyłącznie opis, tytuł sprawdza titleErrors', () => {
  assert.equal(parse.length, 1);
  assert.equal(titleErrors.length, 1);
  assert.deepEqual(Object.keys(syntax).sort(), ['parse', 'titleErrors']);
  const body = `Fixes ${H}12\nopis`;
  const title = `feat: resolves ${H}5`;
  assert.deepEqual(parse(body).errors, [], 'opis poprawny');
  assert.deepEqual(titleErrors(title), [TITLE_ERROR], 'tytuł czerwony w kontroli PR');
  assert.deepEqual(parse(body, title), parse(body), 'drugi argument jest ignorowany: parser nie widzi tytułu');
});

test('parser jest czysty: bez efektów ubocznych i bez zależności', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, '.github/standard/pr-link/pr_link_syntax.js'), 'utf8');
  assert.doesNotMatch(source, /require\(/);
  assert.doesNotMatch(source, /\bprocess\b|\bfs\b|\bhttps?\.|fetch\(/);
});

test('wydajność: długie wejścia kończą się szybko (bez katastrofalnego nawrotu)', () => {
  const started = Date.now();
  parse(`Fixes ${H}12\n${'fixes '.repeat(50000)}`);
  parse(`Fixes ${H}12\n${'a'.repeat(200000)}/${'b'.repeat(200000)}`);
  parse(`Fixes ${H}12\ncloses ${'a-'.repeat(100000)}x/${'.'.repeat(100000)}`);
  parse(`Fixes ${H}12\n${' '.repeat(200000)}Refs`);
  titleErrors(`closes ${'a/'.repeat(100000)}`);
  assert.ok(Date.now() - started < 2000);
});

test('komentarze HTML niczego nie ukrywają: ocena obejmuje ich treść, nie jest ich wycinaniem', () => {
  const stripped = (body) => body.replace(/<!--[\s\S]*?(?:-->|--!>)/g, '');
  for (const body of ['Fixes #12\n<!-- Closes #9 -->', 'Refs #12\n<!-- Fixes #13 -->', 'Fixes #12\n<!--\nukryte\nCloses #9\n-->',
    'Fixes #12\n<!-- Closes #9 --!>']) {
    assert.notDeepEqual(parse(body).errors, [], body);
    assert.deepEqual(parse(stripped(body)).errors, [], `po wycięciu komentarzy byłoby zielone: ${body}`);
  }
  assert.notEqual(parse('<!-- Fixes #12 -->\nFixes #12').errors.length, 0);
  assert.deepEqual(parse('Fixes #12\n<!-- Refs #13 -->'), { kind: 'Fixes', issue: 12, errors: [] });
});
