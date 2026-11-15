'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commentError } = require('./html-comments');

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
