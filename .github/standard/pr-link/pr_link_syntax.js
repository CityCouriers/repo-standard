'use strict';
// Wzorcowy parser składni powiązania PR ze zgłoszeniem (README, sekcja „Składnia powiązania”).
//
// Czyste funkcje, bez sieci i bez dostępu do plików. Stan zgłoszenia (istnieje, nie jest PR, jest otwarte)
// sprawdza kontrola PR przez API, nie ten moduł. Tytuł PR sprawdza `titleErrors`, wywołana przez kontrolę PR obok
// `parse`: `parse` dostaje wyłącznie opis.
//
// Umowa: pierwsza linia opisu to dokładnie `Fixes #<n>` albo `Refs #<n>`; pozostałe linie nie mają drugiego
// powiązania ani słowa zamykającego z odwołaniem. Komentarze HTML niczego nie ukrywają: skanowana jest cała treść.

const FIRST_LINE = /^(Fixes|Refs) #([1-9][0-9]{0,8})[ \t]*$/;

// Słowa zamykające GitHuba z odwołaniem do zgłoszenia, na tekście sprowadzonym do małych liter. Wyrażenie nie ma
// kotwicy na końcu, więc wystarczy jedna cyfra numeru: dalsze cyfry niczego nie zmieniają.
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]+(?:#[0-9]|gh-[0-9]|[a-z0-9_.-]+\/[a-z0-9_.-]+#[0-9]|https?:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/issues\/[0-9])/;

// Drugie powiązanie: `Refs` (z dwukropkiem lub bez) na początku dalszej linii; `Fixes` łapie CLOSING.
const SECOND_REFS = /^[ \t]*refs?:?[ \t]*#[0-9]/;

const FIRST_LINE_ERROR = 'pierwsza linia opisu musi mieć postać `Fixes #<n>` albo `Refs #<n>` '
  + '(dokładnie, bez dwukropka i dopisków, jedno zgłoszenie, liczba bez zer wiodących)';

/** Błąd dalszej linii (numer linii liczony od 1) albo null. */
function laterLineError(line, number) {
  const lower = line.toLowerCase();
  if (CLOSING.test(lower)) return `linia ${number}: słowo zamykające z odwołaniem do zgłoszenia (dozwolone tylko Fixes w pierwszej linii)`;
  if (SECOND_REFS.test(lower)) return `linia ${number}: drugie powiązanie ze zgłoszeniem (jeden PR, jedno zgłoszenie)`;
  return null;
}

/**
 * Rozbiór opisu PR. `kind` (`Fixes` albo `Refs`) i `issue` są ustawione, gdy pierwsza linia jest poprawna;
 * `errors` niepuste oznacza czerwone niezależnie od `kind`.
 */
function parse(body) {
  if (typeof body !== 'string') return { kind: null, issue: null, errors: ['opis PR nie jest tekstem'] };
  const text = body.startsWith('﻿') ? body.slice(1) : body;
  const lines = text.split(/\r?\n/);
  const errors = [];
  let kind = null;
  let issue = null;
  const match = FIRST_LINE.exec(lines[0]);
  if (match === null) {
    errors.push(FIRST_LINE_ERROR);
  } else {
    kind = match[1];
    issue = Number(match[2]);
  }
  lines.slice(1).forEach((line, index) => {
    const error = laterLineError(line, index + 2);
    if (error !== null) errors.push(error);
  });
  return { kind, issue, errors };
}

/** Błędy tytułu PR: słowo zamykające z odwołaniem do zgłoszenia. */
function titleErrors(title) {
  if (typeof title !== 'string') return ['tytuł PR nie jest tekstem'];
  if (CLOSING.test(title.toLowerCase())) return ['tytuł PR zawiera słowo zamykające z odwołaniem do zgłoszenia'];
  return [];
}

module.exports = { parse, titleErrors };
