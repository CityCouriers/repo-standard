'use strict';
// Czytnik HTML bramki audytu: tokenizer ze stosem, przekreślenia na dowolnej głębokości, fail-closed i wynik końcowy
// reconcilera (etykiety), nie tylko funkcji rozbioru.

const test = require('node:test');
const assert = require('node:assert/strict');
const html = require('../.github/standard/audit/issue-audit-html');
const gate = require('../.github/standard/audit/issue-audit-gate');

const { tokenize, visibleText } = html;
const text = (input, strict = false) => visibleText(input, strict);

test('tokenize: teksty, znaczniki, komentarze i atrybuty z cudzysłowami zawierającymi >', () => {
  const { tokens } = tokenize('a<b title="x > y" hidden class=\'k l\' data-x=1>c<!-- ukryty -->d</b><br/>');
  assert.deepEqual(tokens.map(t => t.type + ':' + (t.name || t.value)), ['text:a', 'open:b', 'text:c', 'text:d', 'close:b', 'open:br']);
  assert.deepEqual(tokens[1].attrs, ['title', 'hidden', 'class', 'data-x']);
  assert.equal(tokens[1].classAttr, 'k l');
  assert.equal(tokens[5].selfClosing, true);
  assert.equal(tokens[1].selfClosing, false);
  assert.equal(tokens[1].start, 1);
  assert.equal(tokens[1].end, 1 + '<b title="x > y" hidden class=\'k l\' data-x=1>'.length);
  assert.equal(tokens[4].start, 'a<b title="x > y" hidden class=\'k l\' data-x=1>c<!-- ukryty -->d'.length);
});

test('tokenize: nazwy znaczników i atrybutów są w małych literach, nazwa kończy się na znaku spoza [A-Za-z0-9-]', () => {
  const { tokens } = tokenize('<DEL CLASS="X" Data-Y=2>t</DEL>');
  assert.equal(tokens[0].name, 'del');
  assert.deepEqual(tokens[0].attrs, ['class', 'data-y']);
  assert.equal(tokens[0].classAttr, 'X');
  assert.equal(tokens[2].name, 'del');
  assert.equal(tokenize('<my-tag2>').tokens[0].name, 'my-tag2');
  assert.equal(tokenize('<a1b>').tokens[0].name, 'a1b');
});

test('tokenize: puste i brakujące wejście to brak tokenów', () => {
  for (const empty of ['', null, undefined]) assert.deepEqual(tokenize(empty), { tokens: [] });
});

test('tokenize: atrybut bez wartości, spacje wokół =, znak / w środku znacznika i wartość w apostrofach', () => {
  const { tokens } = tokenize('<a  b = "1"   c= \'2\' d =3 / e>x</a>');
  assert.deepEqual(tokens[0].attrs, ['b', 'c', 'd', 'e']);
  assert.equal(tokens[0].selfClosing, false);
  assert.equal(tokenize('<a b/>').tokens[0].selfClosing, true);
  assert.equal(tokenize('<a/ >').tokens[0].selfClosing, false);
  assert.equal(tokenize('<a =x>').tokens[0].attrs.length, 1);
});

test('tokenize: błędy mają stały kod, bez treści wejścia', () => {
  const cases = {
    '<a': 'niezamkniety-znacznik',
    '<a title="x': 'niezamkniety-znacznik',
    '<a title=\'x>': 'niezamkniety-znacznik',
    '<a title=': 'niezamkniety-znacznik',
    '<!-- bez końca': 'niezamkniety-komentarz',
    'a < b': 'nieoczekiwany-znak',
    '<3': 'nieoczekiwany-znak',
    '</3>': 'nieoczekiwany-znak',
    '<': 'nieoczekiwany-znak',
    '<!DOCTYPE html>': 'nieoczekiwany-znak'
  };
  for (const [input, code] of Object.entries(cases)) assert.deepEqual(tokenize(input), { error: code }, input);
  assert.deepEqual(tokenize('x<'), { error: 'nieoczekiwany-znak' });
  assert.deepEqual(tokenize('</'), { error: 'nieoczekiwany-znak' });
});

test('tokenize: komentarz zamknięty od razu i komentarz z > w środku', () => {
  assert.deepEqual(tokenize('<!---->a<!-- > -->b').tokens.map(t => t.value), ['a', 'b']);
  assert.deepEqual(tokenize('<!-->').error, 'niezamkniety-komentarz');
});

test('tokenize: limity znaków i tokenów są włączone włącznie z granicą', () => {
  assert.equal(tokenize('a'.repeat(html.MAX_CHARS)).tokens.length, 1);
  assert.deepEqual(tokenize('a'.repeat(html.MAX_CHARS + 1)), { error: 'za-duzo-znakow' });
  assert.equal(tokenize('<i></i>'.repeat(html.MAX_TOKENS / 2)).tokens.length, html.MAX_TOKENS);
  assert.deepEqual(tokenize('<i></i>'.repeat(html.MAX_TOKENS / 2) + 'x'), { error: 'za-duzo-tokenow' });
  assert.deepEqual(tokenize('<br>'.repeat(html.MAX_TOKENS + 1)), { error: 'za-duzo-tokenow' });
});

test('visibleText: tekst, encje rozwijane po rozbiorze, przycięcie', () => {
  assert.deepEqual(text('  P2 &amp; &lt;b&gt; &quot;x&quot; &#39;y&#39;&nbsp;z  '), { text: 'P2 & <b> "x" \'y\' z' });
  assert.deepEqual(text('&amp;lt;'), { text: '&lt;' });
  assert.deepEqual(text('&lt;del&gt;P1&lt;/del&gt;'), { text: '<del>P1</del>' });
  assert.deepEqual(text(''), { text: '' });
  assert.deepEqual(text(null), { text: '' });
});

test('visibleText: przekreślenie, także zagnieżdżone i mieszane, ukrywa wszystko pod sobą', () => {
  const cases = {
    '<del>P1</del> P2': 'P2',
    '<s>P1</s> P2': 'P2',
    '<strike>P1</strike> P2': 'P2',
    '<del><del>ukryte</del>P1</del>P2': 'P2',
    '<s><s>ukryte</s>P1</s>P2': 'P2',
    '<strike><strike>ukryte</strike>P1</strike>P2': 'P2',
    '<del><s>x</s>P1</del>P2': 'P2',
    '<s>P1<del>x</del></s>P2': 'P2',
    '<strike>P1<s>x</s>P1</strike>P2': 'P2',
    '<del>a<del>b<del>c</del>d</del>e</del>P2': 'P2',
    '<del>P1</del>P2<s>P3</s>': 'P2',
    '<DEL>P1</DEL>P2': 'P2',
    '<del class="x">P1</del>P2': 'P2'
  };
  for (const [input, visible] of Object.entries(cases)) {
    assert.deepEqual(text(input), { text: visible }, input);
    assert.deepEqual(text(input, true), { text: visible }, 'ścisły: ' + input);
  }
});

test('visibleText: przekreślenie z ukośnikiem nie jest znacznikiem pustym (HTML ignoruje ukośnik)', () => {
  assert.deepEqual(text('<del/>P1'), { error: 'niezamkniety-element' });
  assert.deepEqual(text('<s/>P1</s>P2'), { text: 'P2' });
  assert.deepEqual(text('<strike />P1'), { error: 'niezamkniety-element' });
});

test('visibleText: konstrukcje niezbalansowane to błąd, nie widoczna wartość', () => {
  const cases = {
    '<del>P1': 'niezamkniety-element',
    'P1</del>': 'zle-zamkniecie',
    '</del><del>P1': 'zle-zamkniecie',
    '<del></s>P1': 'zle-zamkniecie',
    '<del><s>P1</del></s>': 'zle-zamkniecie',
    '<del><s>P1</s>': 'niezamkniety-element',
    '<s>x</del>P1': 'zle-zamkniecie',
    '<b>P1': 'niezamkniety-element',
    '</b>': 'zle-zamkniecie',
    '<del>P1<': 'nieoczekiwany-znak',
    '<del title="x>P1</del>': 'niezamkniety-znacznik'
  };
  for (const [input, code] of Object.entries(cases)) assert.deepEqual(text(input), { error: code }, input);
});

test('visibleText: elementy void i obce samozamykające się nie otwierają poziomu', () => {
  assert.deepEqual(text('a<br>b<hr>c<img src=x>d<input>e<wbr>f<col>g<area>h<source>i<track>j<embed>k'), { text: 'abcdefghijk' });
  assert.deepEqual(text('<svg><path d="M0"/></svg>P2'), { text: 'P2' });
  assert.deepEqual(text('<svg><path d="M0"/></svg>P2', true), { error: 'tag-spoza-listy' });
  assert.deepEqual(text('<a><path/></a>', false), { text: '' });
  assert.deepEqual(text('<code/>x', true), { error: 'niezamkniety-element' });
  assert.deepEqual(text('<br/>x', true), { text: 'x' });
});

test('visibleText: tryb ścisły dopuszcza tylko listę tagów komórki', () => {
  for (const name of html.CELL_TAGS) {
    const open = html.VOID.includes(name) ? '<' + name + '>' : '<' + name + '>x</' + name + '>';
    assert.equal(text(open, true).error, undefined, name);
  }
  for (const name of ['table', 'img', 'span', 'div', 'details', 'g-emoji', 'svg', 'pre', 'h2', 'u', 'ins']) {
    assert.deepEqual(text('<' + name + '>x</' + name + '>', true), { error: 'tag-spoza-listy' }, name);
    assert.equal(text('<' + name + '>x</' + name + '>', false).error, name === 'img' ? 'zle-zamkniecie' : undefined, name + ' luźny');
  }
});

test('visibleText: atrybuty ukrywające odrzucają komórkę w trybie ścisłym, w luźnym nie', () => {
  for (const attr of ['hidden', 'style="display:none"', 'aria-hidden="true"', 'HIDDEN', 'Style=x']) {
    assert.deepEqual(text('<code ' + attr + '>P1</code>', true), { error: 'atrybut-ukrywajacy' }, attr);
    assert.deepEqual(text('<code ' + attr + '>P1</code>', false), { text: 'P1' }, attr + ' luźny');
  }
  assert.deepEqual(text('<a href="#x" title="hidden style" rel="nofollow">P1</a>', true), { text: 'P1' });
});

test('visibleText: błąd rozbioru przepisuje kod tokenizera', () => {
  assert.deepEqual(text('<!-- x', true), { error: 'niezamkniety-komentarz' });
  assert.deepEqual(text('a'.repeat(html.MAX_CHARS + 1)), { error: 'za-duzo-znakow' });
});

// Niezależny model referencyjny: rekurencyjny rozbiór drzewa zamiast stosu. Tokeny to wyłącznie przekreślenia, tekst
// `x` i wartość `P1`. Ciąg jest poprawny, gdy drzewo się domyka; widoczne jest to, co leży poza przekreśleniem.
function model(tokens) {
  let pos = 0;
  function parse(closer) {
    const visible = [];
    while (pos < tokens.length) {
      const token = tokens[pos];
      pos += 1;
      if (token.startsWith('</')) return token.slice(2, -1) === closer ? { visible } : null;
      if (token.startsWith('<')) {
        const child = parse(token.slice(1, -1));
        if (child === null) return null;
        continue;
      }
      visible.push(token);
    }
    return closer === null ? { visible } : null;
  }
  const tree = parse(null);
  return tree === null ? null : tree.visible.join('');
}

test('wyczerpująco: każdy ciąg tokenów do długości 6 daje wynik zgodny z modelem referencyjnym', () => {
  const alphabet = ['<del>', '</del>', '<s>', '</s>', '<strike>', '</strike>', 'x', 'P1'];
  let checked = 0;
  let valid = 0;
  const walk = (prefix, depth) => {
    const expected = model(prefix);
    const got = visibleText(prefix.join(''), true);
    if (expected === null) assert.ok(got.error, prefix.join('') + ' powinien być odrzucony');
    else {
      valid += 1;
      assert.deepEqual(got, { text: expected }, prefix.join(''));
      assert.ok(!expected.includes('P1') || prefix.join('').length > 0);
    }
    checked += 1;
    if (depth === 6) return;
    for (const token of alphabet) walk(prefix.concat(token), depth + 1);
  };
  walk([], 0);
  assert.equal(checked, (8 ** 7 - 1) / 7);
  assert.ok(valid > 1000);
});

// Wynik końcowy reconcilera: tabela „Triage” z wartością zbudowaną z konstrukcji ze zgłoszenia recenzenta.
const CONFIG = { gateActiveSince: '2026-11-15T00:00:00Z', triageActiveSince: '2026-11-15T00:00:00Z', triageRequired: ['P', 'T'] };
const REPO_LABELS = ['P0', 'P1', 'P2', 'P3', 'T1', 'T2', 'T3', 'area:process', gate.NEEDS_TRIAGE, 'audit:pending', 'audit:ok', 'audit:changes'];
const table = (priority, risk) => '<h2>Triage</h2><table><thead><tr><th>pole</th><th>wartość</th></tr></thead><tbody>' +
  '<tr><td>priorytet</td><td>' + priority + '</td></tr><tr><td>ryzyko</td><td>' + risk + '</td></tr></tbody></table>';
const outcome = (bodyHtml) => gate.reconcileIssue({
  state: 'open', labels: [], createdAt: '2026-11-15T10:00:00Z', barrier: '2026-11-15T10:00:00Z', bodyHtml, repoLabels: REPO_LABELS,
  body: 'x\n\n_— Claude Code (agent lokalny)_', app: '', comments: []
}, CONFIG, '2026-11-15T10:00:05Z');

test('końcowe etykiety: ukryte P1 i T3 w zagnieżdżonych przekreśleniach nigdy nie ustawiają etykiety', () => {
  const hidden = [
    ['<del><del>ukryte</del>P1</del>', '<del><del>ukryte</del>T3</del>'],
    ['<s><s>ukryte</s>P1</s>', '<s><s>ukryte</s>T3</s>'],
    ['<strike><strike>ukryte</strike>P1</strike>', '<strike><strike>ukryte</strike>T3</strike>'],
    ['<del><s>x</s>P1</del>', '<s><del>x</del>T3</s>'],
    ['<strike>P1<s>x</s></strike>', '<del>T3<del>x</del></del>']
  ];
  for (const [priority, risk] of hidden) {
    const result = outcome(table(priority, risk));
    assert.deepEqual(result.triage.add, [gate.NEEDS_TRIAGE], priority);
    assert.ok(!result.labels.includes('P1') && !result.labels.includes('T3'), priority);
    assert.equal(result.triage.unreadable, '', priority);
  }
});

test('końcowe etykiety: przy widocznym P2 obok ukrytego P1 powstaje wyłącznie P2', () => {
  const result = outcome(table('<del><del>x</del>P1</del> P2', '<s><s>x</s>T3</s> <strong>T2</strong>'));
  assert.deepEqual(result.triage.add, ['P2', 'T2']);
  assert.deepEqual(result.labels, ['P2', 'T2']);
});

test('końcowe etykiety: konstrukcje niezbalansowane i nieznane unieważniają całą tabelę (needs-triage, zero etykiet)', () => {
  const unreadable = {
    '<del>P1': 'niezamkniety-element',
    'P1</del>': 'zle-zamkniecie',
    '<del></s>P1': 'zle-zamkniecie',
    '<del><s>P1</del></s>': 'zle-zamkniecie',
    '<span>P1</span>': 'tag-spoza-listy',
    '<img alt="P1">': 'tag-spoza-listy',
    '<code hidden>P1</code>': 'atrybut-ukrywajacy',
    '<code style="display:none">P1</code>': 'atrybut-ukrywajacy',
    '<code aria-hidden="true">P1</code>': 'atrybut-ukrywajacy',
    '<a title="P1>P2': 'niezamkniety-znacznik'
  };
  for (const [priority, code] of Object.entries(unreadable)) {
    const result = outcome(table(priority, 'T2'));
    assert.deepEqual(result.triage.add, [gate.NEEDS_TRIAGE], priority);
    assert.equal(result.triage.unreadable, code, priority);
    assert.match(result.triage.reason, new RegExp('triage nieczytelne: ' + code), priority);
    assert.ok(!result.labels.includes('T2'), 'żadna etykieta z nieczytelnej tabeli: ' + priority);
  }
});

test('końcowe etykiety: przekroczony limit tokenów to nieczytelna tabela, nie pusty widoczny tekst', () => {
  const result = outcome(table('<i></i>'.repeat(html.MAX_TOKENS) + 'P1', 'T2'));
  assert.deepEqual(result.triage.add, [gate.NEEDS_TRIAGE]);
  assert.equal(result.triage.unreadable, 'za-duzo-tokenow');
});

test('końcowe etykiety: encje nie tworzą przekreślenia ani znaczników', () => {
  const result = outcome(table('&lt;del&gt;P1&lt;/del&gt; P2', '&lt;s&gt;T3 T2'));
  assert.deepEqual(result.triage.add, [gate.NEEDS_TRIAGE], 'P1 i P2 obok siebie to niejednoznaczność, nie ukrycie');
  const single = outcome(table('&lt;del&gt;x&lt;/del&gt;P2', 'T2'));
  assert.deepEqual(single.triage.add, ['P2', 'T2']);
});

test('końcowe etykiety: komentarze HTML i atrybuty z > w komórce są czytane w tym samym przebiegu', () => {
  const result = outcome(table('<!-- <del> -->P2 <a title="a > b" href="#x">link</a>', '<code class="x">T2</code>'));
  assert.deepEqual(result.triage.add, ['P2', 'T2']);
  const comment = outcome(table('<!-- bez końca P1', 'T2'));
  assert.equal(comment.triage.unreadable, 'niezamkniety-komentarz');
});

test('nagłówek „Triage”: nieczytelny nagłówek drugiego poziomu unieważnia odczyt, ukryty tekst nagłówka nie jest nagłówkiem', () => {
  assert.deepEqual(gate.readTriage('<h2><del>Triage</del></h2><table><tr><td>priorytet</td><td>P1</td></tr></table>'), { rows: [], unreadable: '' });
  assert.equal(gate.readTriage('<h2>Tri<del>age</h2><table></table>').unreadable, 'niezamkniety-element');
  assert.equal(gate.readTriage('<h2>Triage<').unreadable, 'nieoczekiwany-znak');
  assert.deepEqual(gate.readTriage('<h2><a id="x" class="anchor"><svg><path d="M0"/></svg></a>Triage</h2><table><tr><td>priorytet</td><td>P1</td></tr></table>'),
    { rows: [['priorytet', 'P1']], unreadable: '' });
  assert.deepEqual(gate.readTriage('<h2>a</h2><h2>b'), { rows: [], unreadable: '' });
});

test('tokenize: klasa bez cudzysłowu, brak klasy daje pusty napis, a visibleText domyślnie działa w trybie luźnym', () => {
  assert.equal(tokenize('<div class=foo>').tokens[0].classAttr, 'foo');
  assert.equal(tokenize('<div class = foo bar>').tokens[0].classAttr, 'foo');
  assert.equal(tokenize('<b>').tokens[0].classAttr, '');
  assert.deepEqual(visibleText('<span>x</span>'), { text: 'x' });
  assert.deepEqual(visibleText('<span>x</span>', true), { error: 'tag-spoza-listy' });
});
