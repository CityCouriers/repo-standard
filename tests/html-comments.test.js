'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commentError, stripCommentsOnce, stripComments } = require('./html-comments');

test('poprawne komentarze i brak komentarzy', () => {
  for (const text of ['', 'tekst', '<!-- a -->', '<!-- a --!>', 'x <!-- a --> y <!-- b --!> z', '<!-->', '<!--->', '<!-->x<!-- y -->',
    '<!-- a -- b -->', '<!--\nwiele\nlinii\n-->\n']) {
    assert.equal(commentError(text), null, JSON.stringify(text));
  }
});

test('--!> kończy komentarz tak jak -->', () => {
  assert.equal(commentError('<!-- a --!>'), null);
  assert.equal(commentError('<!-- a --!> <!-- b --!>'), null);
  assert.equal(commentError('<!-- a --!> b --!>'), 'koniec komentarza bez początku');
  assert.equal(commentError('<!-- a --!> <!-- b'), 'niezamknięty komentarz');
});

test('komentarze puste <!--> i <!---> zamykają się same', () => {
  assert.equal(commentError('<!--> <!--->'), null);
  assert.equal(commentError('<!--> -->'), 'koniec komentarza bez początku');
  assert.equal(commentError('<!---> --!>'), 'koniec komentarza bez początku');
  assert.equal(commentError('<!-- <!--> -->'), 'zagnieżdżony komentarz');
});

test('wady: niezamknięty, zagnieżdżony, koniec bez początku', () => {
  assert.equal(commentError('<!-- a'), 'niezamknięty komentarz');
  assert.equal(commentError('<!-- a <!-- b -->'), 'zagnieżdżony komentarz');
  assert.equal(commentError('a -->'), 'koniec komentarza bez początku');
  assert.equal(commentError('a --!>'), 'koniec komentarza bez początku');
  assert.equal(commentError('<!-- a --> -->'), 'koniec komentarza bez początku');
  assert.equal(commentError('--> <!-- a -->'), 'koniec komentarza bez początku');
});

test('stripCommentsOnce: wycina komentarze od najbliższego początku do najbliższego końca', () => {
  assert.equal(stripCommentsOnce(''), '');
  assert.equal(stripCommentsOnce('bez komentarzy'), 'bez komentarzy');
  assert.equal(stripCommentsOnce('a<!-- x -->b'), 'ab');
  assert.equal(stripCommentsOnce('a<!-- x --!>b'), 'ab');
  assert.equal(stripCommentsOnce('a<!-- x -->b<!-- y --!>c'), 'abc');
  assert.equal(stripCommentsOnce('a<!-- x --!>b<!-- y -->c'), 'abc');
  assert.equal(stripCommentsOnce('<!--\nwiele\nlinii\n-->tekst'), 'tekst');
  assert.equal(stripCommentsOnce('a<!-- x --> b --> c'), 'a b --> c');
  assert.equal(stripCommentsOnce('a<!-- x --!> b --!> c'), 'a b --!> c');
  assert.equal(stripCommentsOnce('a<!-- x --!> b --> c'), 'a b --> c');
  assert.equal(stripCommentsOnce('a<!-- x --> b --!> c'), 'a b --!> c');
});

test('stripCommentsOnce: niezamknięty komentarz zostaje, koniec liczony dopiero za początkiem', () => {
  assert.equal(stripCommentsOnce('a<!-- x'), 'a<!-- x');
  assert.equal(stripCommentsOnce('a<!-- x --> b <!-- y'), 'a b <!-- y');
  assert.equal(stripCommentsOnce('a<!-->b'), 'a<!-->b');
  assert.equal(stripCommentsOnce('a<!--->b'), 'a<!--->b');
  assert.equal(stripCommentsOnce('a<!--!>b'), 'a<!--!>b');
  assert.equal(stripCommentsOnce('a --> <!-- x -->b'), 'a --> b');
  assert.equal(stripCommentsOnce('a --!> <!-- x --!>b'), 'a --!> b');
});

test('jedno przejście zostawia resztki, stan stały jest czysty', () => {
  const nested = '<!-<!-- x -->- y -->';
  assert.equal(stripCommentsOnce(nested), '<!-- y -->');
  assert.equal(stripComments(nested), '');
  assert.equal(stripComments('p<!-<!-- x -->- y -->q'), 'pq');
  assert.equal(stripComments('<!-<!-<!-- a -->- b -->- c -->'), '');
  assert.equal(stripComments('<!-<!-- x --!>- y --!>'), '');
  assert.equal(stripComments('bez komentarzy'), 'bez komentarzy');
  assert.equal(stripComments('a<!-- x'), 'a<!-- x');
});
