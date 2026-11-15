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

module.exports = { commentError };
