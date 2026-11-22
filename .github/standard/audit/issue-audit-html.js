'use strict';

/**
 * Czytnik HTML-a wyrenderowanego przez GitHuba (`bodyHTML`) dla bramki audytu.
 *
 * Jeden przebieg po znakach, bez wyrażeń regularnych z cofaniem i bez wielokrotnego usuwania w pętli. Kształt
 * dokumentu rozstrzyga stos otwartych elementów: tekst pod otwartym `del`, `s` albo `strike`, na dowolnej głębokości
 * zagnieżdżenia, jest ukryty (autor wycofał tę wartość). Czego czytnik nie rozumie, tego nie zgaduje: błąd rozbioru to
 * wynik z kodem powodu, a wołający traktuje go jako brak danych (fail-closed), nigdy jako pusty tekst widoczny.
 *
 * Wynik błędu to zawsze `{ error: <kod> }` bez żadnej treści wejścia: kody trafiają do publicznego logu przebiegu.
 */

const MAX_CHARS = 2000000;
const MAX_TOKENS = 200000;

/** Elementy, pod którymi tekst jest wycofany przez autora. */
const STRIKE = ['del', 's', 'strike'];

/** Elementy bez treści: nie otwierają poziomu zagnieżdżenia. */
const VOID = ['br', 'hr', 'img', 'input', 'wbr', 'col', 'area', 'source', 'track', 'embed'];

/** Tagi dozwolone w komórce wartości tabeli (tryb ścisły); każdy inny to konstrukcja, której nie rozumiemy. */
const CELL_TAGS = ['a', 'code', 'em', 'strong', 'b', 'i', 'br', 'p', 'del', 's', 'strike'];

/** Atrybuty, które mogą ukryć albo zmienić widoczność treści: w trybie ścisłym tabela jest wtedy nieczytelna. */
const HIDING_ATTRIBUTES = ['hidden', 'style', 'aria-hidden'];

const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9-]/;
const SPACE = /[ \t\r\n\f]/;

// Predykaty znaków. Koniec wejścia to pusty napis (`charAt` poza zakresem), który żaden z nich nie przyjmuje, więc
// pętle przesuwające pozycję kończą się na końcu wejścia bez osobnego sprawdzania długości.
const isNameChar = ch => NAME_CHAR.test(ch);
const isSpace = ch => SPACE.test(ch);
const isAttrNameChar = ch => ch !== '' && !SPACE.test(ch) && ch !== '=' && ch !== '>' && ch !== '/';
const isUnquotedValueChar = ch => ch !== '' && !SPACE.test(ch) && ch !== '>';

/** Pozycja pierwszego znaku od `pos`, który nie spełnia `test` (albo koniec wejścia). */
function skip(html, pos, test) {
  let next = pos;
  while (test(html.charAt(next))) next += 1;
  return next;
}

/** Wartość atrybutu od `pos` (za `=` i spacjami): w cudzysłowie albo apostrofach, inaczej do spacji lub `>`. */
function readValue(html, pos) {
  const quote = html.charAt(pos);
  if (quote === '"' || quote === "'") {
    const close = html.indexOf(quote, pos + 1);
    if (close === -1) return { error: 'niezamkniety-znacznik' };
    return { value: html.slice(pos + 1, close), pos: close + 1 };
  }
  const end = skip(html, pos, isUnquotedValueChar);
  return { value: html.slice(pos, end), pos: end };
}

/**
 * Odczyt znacznika od pozycji `at` (wskazuje `<`): nazwa, nazwy atrybutów, znacznik samozamykający i pozycja za `>`.
 * Cudzysłowy w wartościach atrybutów są rozumiane, więc `>` w wartości nie kończy znacznika; niezamknięty cudzysłów albo
 * brak `>` to błąd.
 */
function readTag(html, at) {
  let pos = at + 1;
  const closing = html.charAt(pos) === '/';
  if (closing) pos += 1;
  const nameEnd = skip(html, pos, isNameChar);
  const name = html.slice(pos, nameEnd).toLowerCase();
  pos = nameEnd;
  const attrs = [];
  let classAttr = '';
  let selfClosing = false;
  for (;;) {
    pos = skip(html, pos, isSpace);
    const ch = html.charAt(pos);
    if (ch === '') return { error: 'niezamkniety-znacznik' };
    if (ch === '>') return { name, closing, attrs, classAttr, selfClosing, end: pos + 1 };
    if (ch === '/') {
      selfClosing = html.charAt(pos + 1) === '>';
      pos += 1;
      continue;
    }
    const attrEnd = skip(html, pos, isAttrNameChar);
    const attrName = html.slice(pos, attrEnd).toLowerCase();
    attrs.push(attrName);
    pos = skip(html, attrEnd, isSpace);
    if (html.charAt(pos) !== '=') continue;
    const read = readValue(html, skip(html, pos + 1, isSpace));
    if (read.error) return read;
    if (attrName === 'class') classAttr = read.value;
    pos = read.pos;
  }
}

/**
 * Rozbiór na znaczniki i teksty: `{ tokens }` albo `{ error }`. Komentarze są pomijane. Gołe `<` poza znacznikiem
 * i komentarzem to błąd: renderer GitHuba koduje je jako `&lt;`, więc jego wystąpienie oznacza HTML, którego nie znamy.
 */
function tokenize(html) {
  const text = String(html ?? '');
  if (text.length > MAX_CHARS) return { error: 'za-duzo-znakow' };
  const tokens = [];
  let pos = 0;
  while (pos < text.length) {
    if (tokens.length >= MAX_TOKENS) return { error: 'za-duzo-tokenow' };
    if (text[pos] !== '<') {
      const next = text.indexOf('<', pos);
      const end = next === -1 ? text.length : next;
      tokens.push({ type: 'text', value: text.slice(pos, end) });
      pos = end;
    } else if (text.startsWith('<!--', pos)) {
      const close = text.indexOf('-->', pos + 4);
      if (close === -1) return { error: 'niezamkniety-komentarz' };
      pos = close + 3;
    } else if (NAME_START.test(text[pos + 1] ?? '') || (text[pos + 1] === '/' && NAME_START.test(text[pos + 2] ?? ''))) {
      const tag = readTag(text, pos);
      if (tag.error) return tag;
      tokens.push({
        type: tag.closing ? 'close' : 'open', name: tag.name, attrs: tag.attrs, classAttr: tag.classAttr,
        selfClosing: tag.selfClosing, start: pos, end: tag.end
      });
      pos = tag.end;
    } else {
      return { error: 'nieoczekiwany-znak' };
    }
  }
  return { tokens };
}

/** Czy `<nazwa ... />` jest znacznikiem bez treści: tylko elementy void i obce (np. `path`), nigdy przekreślenie ani tag komórki. */
function isEmptyTag(token, strict) {
  if (VOID.includes(token.name)) return true;
  if (STRIKE.includes(token.name)) return false;
  return token.selfClosing && !strict;
}

function strictError(token) {
  if (!CELL_TAGS.includes(token.name)) return 'tag-spoza-listy';
  if (token.attrs.some(name => HIDING_ATTRIBUTES.includes(name))) return 'atrybut-ukrywajacy';
  return '';
}

/** Stos otwartych elementów: zamknięcie musi trafić w szczyt, a na końcu stos musi być pusty. */
function walk(tokens, strict) {
  const stack = [];
  let hidden = 0;
  let text = '';
  for (const token of tokens) {
    if (token.type === 'text') {
      if (!hidden) text += token.value;
    } else if (token.type === 'open') {
      const error = strict ? strictError(token) : '';
      if (error) return { error };
      if (isEmptyTag(token, strict)) continue;
      stack.push(token.name);
      if (STRIKE.includes(token.name)) hidden += 1;
    } else {
      if (stack[stack.length - 1] !== token.name) return { error: 'zle-zamkniecie' };
      stack.pop();
      if (STRIKE.includes(token.name)) hidden -= 1;
    }
  }
  if (stack.length) return { error: 'niezamkniety-element' };
  return { text };
}

const ENTITIES = [['&nbsp;', ' '], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', '\''], ['&amp;', '&']];

/** Encje rozwijane dopiero PO rozbiorze znaczników, więc `&lt;del&gt;` zostaje tekstem. `&amp;` na końcu, żeby `&amp;lt;` dało `&lt;`. */
function decodeEntities(text) {
  return ENTITIES.reduce((result, [entity, value]) => result.split(entity).join(value), text);
}

/**
 * Widoczny tekst fragmentu HTML-a: `{ text }` albo `{ error: <kod> }`. Tryb ścisły (komórki tabeli) dodatkowo
 * odrzuca tagi spoza listy i atrybuty ukrywające; tryb luźny (domyślny; nagłówki z kotwicą i ikoną) nie.
 */
function visibleText(html, strict) {
  const scanned = tokenize(html);
  if (scanned.error) return scanned;
  const walked = walk(scanned.tokens, strict);
  if (walked.error) return walked;
  return { text: decodeEntities(walked.text).trim() };
}

module.exports = { tokenize, visibleText, isEmptyTag, MAX_CHARS, MAX_TOKENS, STRIKE, VOID, CELL_TAGS, HIDING_ATTRIBUTES };
