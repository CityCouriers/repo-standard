---
name: Zadanie
about: Zmiana, poprawka, dług techniczny albo znalezisko z audytu
labels: needs-triage
---

<!--
Zasady (szablon nie wczytuje się przy zakładaniu z CLI, treść z pliku UTF-8 przez --body-file):
- Każda sekcja wnosi fakt, decyzję, wymaganie albo dowód. Bez wstępów i bez rytualnego N/A.
- Etykiety P, T i area wynikają z tabeli Triage; wpisz po jednej wartości, reszty nie zgaduj.
- by:agent nadaje wyłącznie agent lokalny swoim zgłoszeniom. audit:* nadaje tylko bramka audytu.
- Sekret, token albo dane osobowe wklejone do zgłoszenia uznaj za ujawnione: unieważnij je i usuń z historii.
-->

**Refs:** #nr (zgłoszenie nadrzędne, zależności) albo `brak`
**Rola autora:** Claude Code (agent lokalny) / ChatGPT / właściciel
**Rola recenzenta (audyt specyfikacji):** strona, która nie pisała tej treści

## Cel

Co ma być prawdą po zamknięciu zgłoszenia?

## Kontekst i ustalenia

Fakty z pomiarem i źródłem (komenda, wynik, plik i linia). Hipotezy oznacz jako hipotezy. Dla długu technicznego wypisz lokalizacje.

## Zakres

- [ ] 

## Poza zakresem

Co celowo zostaje dla innych zgłoszeń (numery).

## Ryzyko i wycofanie

Co się stanie, gdy zmiana będzie błędna; jak ją wycofać. Podstawa do `T1`-`T3`.

## Co zamyka

Weryfikowalne kryteria z dowodem (komenda i wynik, test pozytywny i negatywny).

- AC-1: 

## Triage

| pole | wartość |
| --- | --- |
| priorytet | P0-P4 |
| ryzyko | T1-T3 |
| obszar | area:* |

Podpis: zastąp tę linię jedną z dwóch (zawsze ostatnia linia treści): `_— Claude Code (agent lokalny)_` albo `_— ChatGPT_`
