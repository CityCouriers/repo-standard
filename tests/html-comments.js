'use strict';
// Kontrola komentarzy HTML w treści szablonu, zgodna z rozbiorem przeglądarki (specyfikacja HTML, komentarze):
// komentarz kończy `-->` albo `--!>`, a `<!-->` i `<!--->` to komentarze puste zamknięte od razu.
// Zagnieżdżone `<!--` wewnątrz komentarza przeglądarka traktuje jako tekst; tu jest to błąd (ostrzejsza kontrola szablonu).

const TOKEN = /<!--(?:-?>)?|--!?>/g;

/** Zwraca opis pierwszej wady (zagnieżdżony, niezamknięty albo nadmiarowy koniec komentarza) albo null. */
function commentError(text) {
  let open = false;
  for (const token of text.match(TOKEN) ?? []) {
    if (token.startsWith('<!--')) {
      if (open) return 'zagnieżdżony komentarz';
      open = token === '<!--';
    } else {
      if (!open) return 'koniec komentarza bez początku';
      open = false;
    }
  }
  return open ? 'niezamknięty komentarz' : null;
}

/** Jedno przejście: wycina kolejne komentarze od najbliższego początku do najbliższego końca (--> albo --!>); niezamknięty zostaje. */
function stripCommentsOnce(text) {
  let result = '';
  let position = 0;
  for (;;) {
    const start = text.indexOf('<!--', position);
    if (start === -1) return result + text.slice(position);
    const close = text.indexOf('-->', start + 4);
    const bang = text.indexOf('--!>', start + 4);
    const found = [[close, 3], [bang, 4]].filter(([index]) => index !== -1).sort((a, b) => a[0] - b[0])[0];
    if (found === undefined) return result + text.slice(position);
    result += text.slice(position, start);
    position = found[0] + found[1];
  }
}

/** Wycinanie do stanu stałego: jedno przejście może złożyć z resztek nowy komentarz (np. <!-<!-- x -->- y -->). */
function stripComments(text) {
  let current = text;
  for (let next = stripCommentsOnce(current); next !== current; next = stripCommentsOnce(current)) current = next;
  return current;
}

module.exports = { commentError, stripCommentsOnce, stripComments };
