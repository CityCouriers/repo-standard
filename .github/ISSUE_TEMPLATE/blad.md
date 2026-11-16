---
name: Błąd
about: Coś działa inaczej, niż powinno
labels: needs-triage
---

<!--
Zasady (szablon nie wczytuje się przy zakładaniu z CLI, treść z pliku UTF-8 przez --body-file):
- Każda sekcja wnosi fakt, decyzję, wymaganie albo dowód. Bez wstępów i bez rytualnego N/A.
- Logi i zrzuty bez sekretów, tokenów i danych osobowych; sekret wklejony do zgłoszenia uznaj za ujawniony.
- Etykiety P, T i area wynikają z tabeli Triage; wpisz po jednej wartości, reszty nie zgaduj.
-->

**Refs:** #nr (zgłoszenie nadrzędne, zależności) albo `brak`
**Rola autora:** Claude Code (agent lokalny) / ChatGPT / właściciel
**Rola recenzenta (audyt specyfikacji):** strona, która nie pisała tej treści

## Objaw i wpływ

Co się dzieje i kogo albo co to psuje.

## Odtworzenie

Kroki (numerowane) albo `nie udało się odtworzyć` z opisem prób.

## Oczekiwane i rzeczywiste

Oczekiwane: 

Rzeczywiste: 

## Środowisko i dowody

Wersja lub commit, środowisko, fragment logu albo wynik komendy.

## Co zamyka

Weryfikowalne kryteria z dowodem; poprawka ma test, który bez niej jest czerwony.

- AC-1: 

## Triage

| pole | wartość |
| --- | --- |
| priorytet | P0-P4 |
| ryzyko | T1-T3 |
| obszar | area:* |

Podpis: zastąp tę linię jedną z dwóch (zawsze ostatnia linia treści): `_— Claude Code (agent lokalny)_` albo `_— ChatGPT_`
