Fixes #<nr>
<!--
Pierwsza linia opisu to dokładnie jedna z dwóch form (reguły: README, sekcja „Szablon PR i powiązanie PR ze zgłoszeniem”):
- `Fixes #n` - ostatni PR zgłoszenia, spełnia całe „Co zamyka”; GitHub zamknie zgłoszenie przy scaleniu.
- `Refs #n` - PR częściowy, zgłoszenie zostaje otwarte; zamień pierwszą linię, bez drugiej linii.
Wielkość liter ma znaczenie; bez dwukropka, pogrubień i dopisków; jedno zgłoszenie z tego repozytorium; numer bez zer wiodących.
Innych słów zamykających (close, fix, resolve z odmianami) z odwołaniem do zgłoszenia nie używaj nigdzie w opisie ani w tytule.
Pola niedotyczące tego PR: `N/A (powód)`. Nie zostawiaj placeholderów `<...>`. PR otwieramy jako Draft.
Treść z CLI: gh pr create --draft --body-file <plik UTF-8>.
-->

## Co zmienia i po co

Jedno zdanie o wartości zmiany; co dziś jest źle; co się zmieniło. Przy PR częściowym: co zostaje do zrobienia w zgłoszeniu.

## Realizacja Kryteriów Akceptacji (AC)

<!-- Skopiuj ze zgłoszenia te AC, które ten PR domyka, i odhacz. W Draft mogą być niezaznaczone. -->

- [ ] (wklej AC ze zgłoszenia)

## Dowody

Komenda i wklejone wyjście; test pozytywny i negatywny; pomiar z kontrolą bazową. Konsument dopisuje tu własne pozycje zależne od stosu.

- [ ] **Testy:** nowe zachowanie ma test pozytywny i negatywny, albo N/A (powód)
- [ ] **Kontrola ujemna:** nowa lub zmieniona bramka ma przypadek, który ją zatrzymuje, albo N/A (powód)
- [ ] **Bezpieczeństwo i prywatność:** brak kluczy, danych osobowych, adresów e-mail i danych z prywatnych zasobów, albo N/A (powód)
- [ ] **Wydanie:** wpis w zmianach i klasyfikacja wersji, albo N/A (powód)

## Mutacje

<!--
Dla każdego zmienionego pliku kodu: narzędzie, liczby (zabite, timeouty, ocalałe) i miejsce wyniku. Ocalałe tylko jako
równoważne, z odwołaniem do niezależnego audytu osobnej sesji. Dokumenty i konfiguracja: test zachowania na kopii
(komenda i wynik kontroli zerowej i ujemnej). Brak zmian w kodzie: `N/A (powód)`. Format wiersza jest lokalny.
-->

## Czego nie sprawdzono

Lista albo `brak`.

## Ryzyko i wycofanie

Co może pójść źle i jak to cofnąć.

## Pochodzenie i zmiany względem źródła

<!--
`N/A (powód)`, gdy PR nie przenosi kodu ani szablonów z innego repozytorium. Źródło publiczne: repozytorium i pełny SHA.
Źródło prywatne: nazwa repozytorium i opis przenoszonego zachowania, bez odnośników, ścieżek i numerów.
-->

| plik | zmiana względem źródła | powód |
| --- | --- | --- |
|  |  |  |

Wynik skanu prywatności: liczba trafień.

## Przed Ready for review

- [ ] Pierwsza linia opisu ma numer otwartego zgłoszenia (bez placeholderu)
- [ ] Wymagane kontrole są zielone na bieżącym HEAD
- [ ] Werdykt przeglądu strony, która nie pisała zmiany, dotyczy bieżącego HEAD (pełny SHA)
- [ ] Ready nie jest zgodą na scalenie

Podpis: zastąp tę linię jedną z dwóch (zawsze ostatnia linia treści): `_— Claude Code (agent lokalny)_` albo `_— ChatGPT_`
