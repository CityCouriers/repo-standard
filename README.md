# repo-standard

> **Status: wersja wstępna, przed wydaniem `v1.0.0`.** Działa synchronizator `standard_sync.js` (`check`, `check --self`, `apply`), walidator pliku parametrów, manifest i CI tego repozytorium (testy, skan prywatności, skan sekretów). Działa też bramka audytu zgłoszeń z triage (workflow `issue-audit.yml`, opis w sekcji „Bramka audytu zgłoszeń”), w tym repozytorium: zgłoszenia tego repozytorium są audytowane tą bramką. Pozostałe elementy z tabeli poniżej (`review-gate`, `standard-drift` i inne) powstają w kolejnych zgłoszeniach. Do wydania `v1.0.0` niczego stąd nie wolno kopiować do produkcyjnych repozytoriów.

Docelowo: wspólne przepływy GitHub Actions, skrypty bramek i szablony dla repozytoriów CityCouriers. Każdy element ma mieć jedną wersję wzorcową, a repozytorium, które go używa, kopiuje ją bez zmian i trzyma jeden mały plik parametrów. Rozjazd kopii od wzorca ma wykrywać automat.

## Zasada nadrzędna repozytorium

To repozytorium jest centralnym punktem standardu w obu kierunkach: wszystko, co ma być wspólne, trafia tu i stąd jest pobierane, a poprawka znaleziona w konsumencie wraca tu jako PR, nie zostaje lokalną kopią. Wersję wzorcową elementu wybiera się według zachowania, nie według tego, w którym repozytorium powstała.

Opis każdego PR, który wnosi element do wzorca, zawiera tabelę: **wybrane źródło** (repozytorium i publiczny pełny SHA commita, z którego wzięto kod), **powód wyboru** oraz **dodatki z innych wersji** (co przeniesiono z innych kopii, żeby wzorzec nie zgubił ich zachowania). Zmiany względem źródła wymienia się plik po pliku, z powodem.

Repozytorium wzorca nie konsumuje własnego wydania. W `.github/repo-standard.json` zostaje na stałe znacznik braku wydania: `standard.version` = `v0.0.0` i `standard.sha` złożony z samych zer (40 znaków). Jest to wartość poprawna dla schematu, ale nie wskazuje żadnego commita. Zgodność wzorca z jego własnym manifestem pilnuje `check --self`, a nie `check`.

## Zasada działania (docelowa)

1. Wzorzec jest wydawany z tagiem (`v1.0.0`, `v1.1.0`, ...). Wydanie zawiera `manifest.json`: ścieżkę, rodzaj i sumę SHA-256 każdego pliku.
2. Repozytorium-konsument kopiuje pliki wydania skryptem `standard_sync.js apply`. Skrypt pobiera manifest i pliki z tego publicznego repozytorium po pełnym SHA commita wydania, bez tokenu, i zapisuje wersję oraz SHA w pliku parametrów konsumenta.
3. Workflow `standard-drift.yml` (też kopiowany) biegnie w soboty, przy PR zmieniającym `.github/**` i ręcznie. Porównuje pliki z manifestem wersji z pliku parametrów, sprawdza wygasłe odstępstwa i czy jest nowsze wydanie. Przy PR i przy uruchomieniu ręcznym jest czerwony przy rozjeździe; w sobotę zakłada albo aktualizuje jedno zgłoszenie „Rozjazd wzorca” z etykietami poza zakresem bramki audytu (`P3`, `T1`, `area:process`).
4. Aktualizacja to zwykły PR w repozytorium-konsumencie, z jego własnym audytem i CI. Kontrola nie zapisuje do plików repozytorium: token `GITHUB_TOKEN` nie ma uprawnienia do zmiany plików w `.github/workflows` ([lista uprawnień](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)), więc automatyczna synchronizacja wymagałaby dodatkowego sekretu, którego świadomie nie wprowadzamy.

Przepływy wielokrotnego użytku (`workflow_call`) i, o ile plan organizacji pozwala, reguła organizacji „Require workflows” są opcjami na kolejne wersje, po pilocie.

## Elementy wzorca (zakres `v1.0.0`)

Wersja wzorcowa każdego elementu została wybrana według zachowania, nie według języka. Skrypty są w Node.js (CommonJS, wyłącznie biblioteka standardowa, bez zależności i bez `npm install`), wersja środowiska (Node 22) jest zapisana w workflow.

| element | co robi | parametr lokalny |
| --- | --- | --- |
| bramka audytu zgłoszeń `audit:*` | stan audytu zgłoszeń w zakresie (priorytet P0-P2 albo ryzyko T2/T3): wyłącznie strona przeciwna autorowi wydaje ważny werdykt `/audit-ok` albo `/audit-changes`; autor jest ustalany z trzech zgodnych sygnałów (podpis, etykieta `by:agent`, aplikacja, przez którą powstała treść); edycja treści albo komendy unieważnia werdykt | `audit.active_since` |
| triage | uzupełnia brakujące P, T i area z tabeli „Triage” w treści zgłoszenia, nakłada i zdejmuje `needs-triage`; wymagane rodziny są stałe: P, T, area | `triage.active_since` |
| szablon PR i składnia powiązania | szablon `.github/PULL_REQUEST_TEMPLATE.md` (rodzaj `seed`) i wzorcowy parser pierwszej linii opisu: dokładnie `Fixes #n` (ostatni PR zgłoszenia, zamyka je przy scaleniu) albo `Refs #n` (PR częściowy), jedna składnia we wszystkich repozytoriach; szczegóły w sekcji „Szablon PR i powiązanie PR ze zgłoszeniem” | brak |
| kontrola powiązania PR ze zgłoszeniem (osobny element) | zgłoszenie musi istnieć, nie być PR i być otwarte; słowa zamykające w tytule PR są błędem; PR Dependabota jest wyjątkiem; używa wzorcowego parsera | brak |
| strażnik wersji roboczej | job zbiorczy: PR w Draft jest zawsze czerwony; poza Draft wymagane joby muszą mieć `success`, pozostałe `skipped`; brak wyniku albo wynik nieznany jest czerwony | `quality_gate.jobs`, `quality_gate.required` |
| bramka przeglądu `review-gate` | zielona, gdy ostatni ważny werdykt strony przeciwnej wskazuje pełny SHA HEAD, powiązane zgłoszenia mają `audit:ok`, a zmiana plików bramek ma linię „Zmiana bramki: zaakceptowana”; kod z domyślnej gałęzi | `review_gate.protected_paths` |
| etykiety | rdzeń etykiet (`labels-core.json`: P, T, `blocked`, `needs-triage`, `by:agent`, `audit:*`) kopiowany bez zmian, plus lokalny `.github/labels.json` poza manifestem; synchronizacja zapisuje tylko z domyślnej gałęzi, w dwóch fazach, i weryfikuje stan po zmianie; rdzeń jest nieusuwalny; etykieta spoza obu plików łamie zgodność, ale nie jest ruszana | lokalny `.github/labels.json` |
| skan sekretów `secret-scan` | gitleaks z przypiętą wersją i sumą SHA-256: zakres PR, push, ręczny `--all` i bieg tygodniowy `--all` | opcjonalny `.gitleaks.toml` |
| kontrola workflow `workflow-lint` | actionlint z przypiętą wersją i sumą; osobny workflow z filtrem ścieżek, niewymagany | brak |
| polityka workflow | wszystkie `uses:` spoza repozytorium na pełnym SHA z komentarzem wersji, `permissions: {}` na poziomie workflow, literalny runner GitHub-hosted dla wyzwalaczy PR | brak |
| Dependabot | blok `github-actions`: `weekly`, sobota, grupowanie, etykieta `dependencies` | inne ekosystemy dopisuje konsument |
| release-drafter | autolabeler pomija Draft i forki | lokalny `release-drafter.yml` (kategorie) |
| kontrola rozjazdu | `standard_sync.js`, `standard-drift.yml` | `standard`, `overrides` |

Elementy zależne od repozytorium (treść szablonów, sekcje dowodów w PR, łańcuch narzędzi jakości, budowa wydań, workflow lokalne) zostają w konsumencie. Standard dostarcza tylko szkielet i test spójności: `config.yml` szablonów zgłoszeń, stopkę podpisu, pierwszą linię `Fixes`/`Refs` w szablonie PR oraz test zgodności jobu `quality-gate` z parametrami.

## Szablon PR i powiązanie PR ze zgłoszeniem

Trzy odrębne umowy, które nie są zlewane w jedną:

1. **Sekcje szablonu** (markery w `manifest.json`).
2. **Składnia powiązania PR ze zgłoszeniem** (jedna dla wszystkich repozytoriów; parser, wspólne przypadki testowe).
3. **Podpis strony i powiązanie werdyktu z HEAD** (element „bramka przeglądu `review-gate`”): szablon dostarcza tylko miejsce na podpis; nie ustala, kto jest autorem i czy werdykt dotyczy bieżącego HEAD.

### Szablon `.github/PULL_REQUEST_TEMPLATE.md`

Rodzaj `seed`: kopiowany raz, potem `check` sprawdza wyłącznie markery. Markery (zapisane w `manifest.json`, każdy musi występować w pliku): `Fixes #<nr>` (pierwsza linia), `## Dowody`, `## Mutacje`, `## Ryzyko i wycofanie`, `Podpis:` (linia podpisu strony). Pozostałe sekcje są zalecane i nie są markerami; konsument może je zmienić albo usunąć: `## Co zmienia i po co`, `## Realizacja Kryteriów Akceptacji (AC)`, `## Czego nie sprawdzono`, `## Pochodzenie i zmiany względem źródła`, `## Przed Ready for review`.

- Wzorzec: pierwsza linia i nagłówki kontraktowe z markerów; konwencje: pole niedotyczące to `N/A (powód)`, komentarze HTML to instrukcja, placeholdery stoją w nawiasach `<...>`.
- Parametr (lokalnie w konsumencie, markerów nie zmienia): pozycje dowodów zależne od stosu, wiersz mutacji (narzędzie i format), nazwy lokalnych kontroli w „Przed Ready”, sekcje stosowe (przeglądarka, runtime, macierz testów), konwencja tytułu, gdy konsument ma kontrolę tytułu.
- Sekcję lokalną dopisuje się pod markerami (albo w ich treści); nie zmienia się i nie usuwa linii z markerem. Zmiana nazwy markera to zmiana kontraktu: wpis w `manifest.json`, test w tym repozytorium i kontrola konsumenta w jednym wydaniu.
- `Mutacje`: nagłówek jest kontraktem z kontrolą mutacji (kończy się na następnym nagłówku `#`/`##`); format wiersza (narzędzie, pola) jest lokalny. Dokumenty i konfiguracja: test zachowania na kopii zamiast narzędzia mutacyjnego.
- Domyślna pierwsza linia to `Fixes #<nr>`: placeholder nie jest poprawnym numerem, więc niewypełniony szablon jest czerwony dla parsera.

### Składnia powiązania (jedna we wszystkich repozytoriach)

Decyzja właściciela z 2026-11-15: jedna składnia powiązania; `Fixes` zamyka zgłoszenie przy scaleniu, `Refs` dla PR-a częściowego. Parser: `.github/standard/pr-link/pr_link_syntax.js`, funkcja `parse(body)`; wspólne przypadki testowe: `.github/standard/pr-link/cases.json`.

- **Miejsce:** pierwsza linia opisu PR. Znak BOM na początku jest ignorowany; końce linii LF i CRLF są równoważne. Pusta pierwsza linia, komentarz, odstęp albo cokolwiek przed słowem to błąd.
- **Forma:** dokładnie `Fixes #<n>` albo `Refs #<n>`, gdzie `<n>` to liczba dodatnia bez zer wiodących, najwyżej 9 cyfr, zgłoszenie z tego repozytorium. Cała linia, bez dopisków, pogrubień, kropki i przecinka; dopuszczalne są wyłącznie spacje lub tabulatory na końcu linii.
- **Wielkość liter:** dokładnie `Fixes` i `Refs`; inne warianty (`fixes`, `FIXES`, `Fix`, `Closes`, `Resolves`, `Ref`) są błędem.
- **Dwukropek:** błąd (`Fixes: #n`, `Refs: #n`). Dwukropek nie ma znaczenia dla GitHuba, dlatego nie jest dopuszczony: parsery nie mają dwóch dialektów.
- **Jedno zgłoszenie na PR:** `Fixes #a, #b`, `Fixes #a #b` i druga linia powiązania (`Fixes` albo `Refs` jako początek dalszej linii) to błędy.
- **Słowa zamykające poza pierwszą linią:** błąd wszędzie indziej w treści: każde słowo zamykające GitHuba (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`, wielkość liter bez znaczenia, z dwukropkiem lub bez) z odwołaniem do zgłoszenia (`#n`, `GH-n`, `właściciel/repo#n` albo adres zgłoszenia). Komentarze HTML niczego nie ukrywają i nie są wycinane przed oceną: parser skanuje całą treść, także komentarze (w tym zamknięte `--!>`), więc słowo zamykające z odwołaniem w komentarzu jest błędem tak samo jak poza nim. Uzasadnienie: traktowanie komentarzy przez GitHub nie jest tu zweryfikowane, a zły kierunek błędu zamykałby zgłoszenie. Konsekwencje: `Fixes #n` ukryte w komentarzu nie jest ignorowane (jest błędem), a pierwsza linia będąca komentarzem jest błędem (patrz Miejsce). Linia zaczynająca się od `Refs` jest drugim powiązaniem, ale `Refs` w środku linii (np. wewnątrz komentarza) nie jest powiązaniem i niczego nie zamyka.
- **`Fixes` albo `Refs` jest wymagane:** brak obu (także placeholder `<nr>`) to błąd.
- **Wynik:** `parse(body)` zwraca `{ kind, issue, errors }`. `kind` (`Fixes` albo `Refs`) i `issue` są ustawione, gdy pierwsza linia jest poprawna, a `errors` jest wtedy puste albo opisuje naruszenia w dalszej części. Kontrola PR traktuje niepuste `errors` jako czerwone, niezależnie od `kind`.
- **Tytuł PR:** słowa zamykające z odwołaniem w tytule to błąd, ale parser opisu ich nie sprawdza (nie dostaje tytułu). Sprawdza je kontrola PR funkcją `titleErrors(title)` z tego samego modułu, wywołaną obok `parse(body)`.
- **Poza parserem:** stan zgłoszenia (istnieje, nie jest PR, jest otwarte) sprawdza kontrola PR przez API; komunikaty commitów i komunikat squasha nie są objęte tą umową, więc szablon i parser nie obiecują, że żaden scalony PR nie zamknie zgłoszenia inaczej niż przez pierwszą linię.

Dotychczasowe kontrole w repozytoriach organizacji różniły się: pierwsza linia albo dowolne miejsce w opisie, dwukropek wymagany, zabroniony albo opcjonalny, `Fixes` dozwolone albo zabronione, dodatkowe słowa (`Closes`, `Resolves`, `Ref`). Ta umowa je ujednolica; każda kontrola konsumenta jest zmieniana razem z kolejnym wydaniem wzorca, z własnym PR, audytem i mutacjami zmienionych plików. Do czasu wydania nic w konsumentach od tej umowy nie zależy.

Wspólne przypadki (`cases.json`) przechodzi parser w tym repozytorium; kontrola PR w konsumencie ma przejść te same przypadki (część „body”: wynik `parse`, część „title”: wynik `titleErrors`).

### Kolejność wdrożeń

Szablon i parser wchodzą w wydaniu przed kontrolą PR w konsumencie; kontrole wszystkich konsumentów zmieniane są w jednej fali wydania. Kto wchodzi drugi (kontrola PR albo bramka przeglądu), dopisuje test krzyżowy zgodności z markerami i z przypadkami.

### Testy tego elementu

```bash
node --test "tests/pr-template.test.js" "tests/pr-link-syntax.test.js"
```

`tests/pr-template.test.js` pilnuje zgodności szablonu z manifestem (każdy marker w pliku, każdy nagłówek kontraktowy ma marker), formy niewypełnionego szablonu (czerwony dla parsera, bez słowa zamykającego z numerem, bez placeholderów w formie `#nr`, zbalansowane komentarze), a także kontroli zerowej i ujemnej: szablon bez zmian jest zgodny z `check --self`, a kopia bez któregokolwiek markera jest odrzucona. Zwykły test (bez `todo`) sprawdza na rzeczywistym module `issue-audit-sides.js`, że oba podpisy z szablonu są rozpoznawane jako strona agenta lokalnego i ChatGPT, a niewypełniony szablon nie ustala żadnej strony.

## Plik parametrów `.github/repo-standard.json`

Jedyny plik konsumenta, którego standard nigdy nie nadpisuje.

```json
{
  "schema": 1,
  "standard": { "version": "v1.0.0", "sha": "<pełny SHA 40 znaków>" },
  "audit": { "active_since": "RRRR-MM-DDTGG:MM:SSZ" },
  "triage": { "active_since": "RRRR-MM-DDTGG:MM:SSZ" },
  "quality_gate": { "workflow": "quality.yml", "jobs": ["..."], "required": { "pull_request": ["..."], "push": ["..."], "workflow_dispatch": ["..."] } },
  "review_gate": { "protected_paths": ["config/protected.json"] },
  "overrides": [ { "path": ".github/workflows/x.yml", "reason": "...", "until": "RRRR-MM-DD", "issue": "owner/repo#nr" } ]
}
```

Daty aktywacji leżą w pliku, w historii repozytorium, a nie w zmiennej repozytorium: zmienna zmienia się bez śladu w gicie, a data przesuwa granicę, od której obowiązuje audyt.

## Manifest

| rodzaj | znaczenie |
| --- | --- |
| `exact` | suma SHA-256 pliku musi zgadzać się z manifestem |
| `block` | porównanie bloku tekstu (np. wpisu `github-actions` w `dependabot.yml`), reszta pliku jest lokalna |
| `seed` | plik kopiowany raz; potem sprawdzany tylko kontrakt (wymagane znaczniki) |
| `param` | plik lokalny, walidowany schematem |

Pliki z flagą `critical` (skrypty i workflow bramek, kontroli rozjazdu, polityki, schemat parametrów) są zawsze `exact` i nie mogą mieć odstępstwa. Odstępstwo w `overrides` dotyczy wyłącznie plików z `overridable: true` i wymaga otwartego zgłoszenia z `audit:ok`, terminu najwyżej 90 dni i powodu. Zmiana `overrides` jest zmianą plików bramek.

`manifest.json` nie ma własnego wpisu z sumą (samo-hashowanie jest niewykonalne): jego integralność wynika z przypiętego commita wydania, a `check --self` pilnuje jego schematu i kompletności wpisów. Wpis może mieć `source` (plik źródłowy szablonu, gdy różni się od ścieżki docelowej); manifest nie zawiera pól spoza schematu, w szczególności nie deklaruje własnego SHA commita.

## Skrypt `standard_sync.js`

Node.js (CommonJS, biblioteka standardowa, bez zależności), minimum Node 22. Pliki: `.github/standard/standard_sync.js` i `.github/standard/common/params.js` (walidator pliku parametrów). Skrypt jest plikiem `critical`: kopiowany bez zmian.

```bash
node .github/standard/standard_sync.js check [--root .]
node .github/standard/standard_sync.js check --self [--root .]
node .github/standard/standard_sync.js apply --version v1.0.0 [--sha <pełny SHA>] [--root .] [--dry-run]
```

- `check` porównuje pliki konsumenta z manifestem wersji zapisanej w `.github/repo-standard.json` (manifest jest pobierany po przypiętym pełnym SHA).
- `check --self` działa w repozytorium wzorca: porównuje `manifest.json` z własnymi plikami, pilnuje schematu i kompletności wpisów (plik objęty katalogami wzorca, a niewpisany do manifestu, to rozjazd) oraz sprawdza `overrides` z lokalnego pliku parametrów, jeśli istnieje.
- `apply --version` zamienia tag na pełny SHA commita, pobiera manifest i WSZYSTKIE pliki po tym SHA (tylko https, bez tokenu, przekierowania wyłącznie na ten sam host i https; nie ma wyjątku dla http), sprawdza w pamięci sumy SHA-256, ścieżki, schemat manifestu i zgodność wersji manifestu z tagiem. Dopiero po pełnej weryfikacji zapisuje pliki i na końcu `.github/repo-standard.json`. Błąd na dowolnym etapie pobierania lub weryfikacji oznacza zero zmian w repozytorium, także w pliku parametrów. Z `--sha` obok `--version` SHA tagu musi być równy podanemu.
- Kody wyjścia: 0 zgodne, 1 rozjazd, 2 błąd działania (sieć, zły manifest, zły plik parametrów, odmowa zapisu). Fail-closed.

Bezpieczeństwo zapisów (wszystkie zapisy, także `.github/repo-standard.json`): odmowa ścieżek spoza katalogu repozytorium (`..`), ścieżek w `.git` oraz dowiązań symbolicznych w pliku docelowym i w dowolnym katalogu nadrzędnym. Zapis idzie przez plik tymczasowy w tym samym katalogu (otwarty z wykluczeniem istniejącego pliku, a na platformach, które to wspierają, także dowiązania) i `rename`, po ponownej kontroli ścieżki bezpośrednio przed zapisem. Zostaje wąskie okno wyścigu między ostatnią kontrolą a `rename`, którego bez wsparcia systemu plików nie da się zamknąć; dlatego skrypt jest przeznaczony do repozytorium, w którym nikt inny nie zmienia struktury katalogów w trakcie działania.

Awaria w trakcie wielu zapisów: przed zapisem skrypt zapamiętuje poprzednią treść każdego pliku i przy błędzie przywraca je w odwrotnej kolejności. Wynik jest jawny: komunikat „częściowa awaria zapisu” z listą plików zapisanych, przywróconych i nieprzywróconych (kod 2). Gdy przywrócenie samo zawiedzie, lista wskazuje pliki do ręcznej naprawy z `git checkout`.

Odstępstwa (`overrides`): B1 sprawdza wyłącznie składnię (plik z manifestu z `overridable: true`, nigdy `critical`; zgłoszenie w postaci `wlasciciel/repo#nr`; termin najwyżej 90 dni; powód). Stanu zgłoszenia (otwarte, `audit:ok`) B1 NIE sprawdza: wynik brzmi „składnia poprawna, stan zgłoszenia niezweryfikowany”, a odstępstwo nie jest uznawane za zatwierdzone, więc nie wyłącza kontroli pliku i `apply` go nie pomija. Uznanie odstępstwa wprowadzi dopiero zaufana bramka w kolejnym zgłoszeniu.

### Testy

```bash
node --test "tests/*.test.js"
node .github/standard/standard_sync.js check --self
```

Testy używają wyłącznie danych syntetycznych i lokalnego serwera https z certyfikatem wygenerowanym na czas testu (potrzebny `openssl`; bez niego testy sieciowe są pomijane z jawnym komunikatem). Test dokumentacji pilnuje, żeby README, `THIRD_PARTY.md` i `.github/` nie odsyłały do innej implementacji synchronizatora niż Node.js. Test polityki workflow sprawdza przypięcie akcji do pełnego SHA, `permissions: {}` na poziomie workflow i literalny runner GitHub-hosted.

### CI tego repozytorium

`.github/workflows/ci.yml`: `tests` (Node 22: testy i `check --self`), `privacy` (`scripts/ci/privacy-scan.sh`: ścieżki lokalne, katalogi domowe, adresy e-mail, identyfikatory zgłoszeń w prywatnych repozytoriach; z lokalnym plikiem wzorców spoza repozytorium, wskazanym zmienną `PRIVACY_PATTERNS_FILE`, także zadane nazwy; wzorce nie trafiają do Git ani do logów) i `secret-scan` (gitleaks z przypiętą sumą SHA-256 i kontrolą ujemną na sztucznym tokenie). Skan prywatności z lokalnym plikiem wzorców jest bramką przed wydaniem; w CI biegnie bez niego.

## Bramka audytu zgłoszeń

Pliki: `.github/standard/audit/issue-audit-gate.js` (reconciler i CLI), `issue-audit-sides.js` (ustalanie strony autora i werdyktu), `issue-audit-fetch.js` (odczyt przez GraphQL), `issue-audit-html.js` (czytnik HTML-a tabeli Triage) oraz `.github/workflows/issue-audit.yml`. Wszystkie są `critical` i `exact` w manifeście. Node.js, wyłącznie biblioteka standardowa, bez zależności.

**Model.** Każde uruchomienie czyta bieżący stan zgłoszenia i wylicza docelową etykietę (`audit:pending`, `audit:ok`, `audit:changes`), a potem dopiero porównuje ją z obecną. Zdarzenie może zostać anulowane przez kolejne, więc wynik nie zależy od tego, które zdarzenie obudziło bieg. Workflow reaguje na `issues` (`opened`, `edited`, `labeled`, `unlabeled`, `reopened`) i `issue_comment` (`created`, `edited`, `deleted`). Komentarze innych niż właściciel, członek lub współpracownik są odrzucane w warunku jobu bez czytania ich treści, a komentarze pod PR-ami są pomijane. Grupa współbieżności `issue-audit-<numer>` obejmuje przepuszczone zdarzenia, odrzucone dostają osobną grupę jednorazową i nie anulują niczego.

**Autor.** Strona autora wynika z trzech sygnałów: podpisu (`_— Claude Code (agent lokalny[, rola])_` albo `_— ChatGPT_`), etykiety `by:agent` i aplikacji, przez którą powstała treść. Rola w podpisie ma znaczenie tylko w ostatniej niepustej linii. Niezgodność sygnałów jest brakiem ważnego werdyktu.

**Werdykt jest ważny**, gdy spełnia wszystkie warunki: nie był edytowany (nieznany stan edycji liczy się jak edycja), pochodzi od strony przeciwnej autorowi, jest nowszy niż bariera rewizji zgłoszenia (ostatnia edycja treści, a bez niej data utworzenia) i pochodzi od konta o roli OWNER, MEMBER albo COLLABORATOR. Werdykt wydany przed uzupełnieniem triage jest nieważny: bramka triage jest wyznaczana z osi czasu etykiet. Pominięte werdykty trafiają do logu jako kody powodów z liczbami, bez treści komentarzy.

**Parametry.** Daty `audit.active_since` i `triage.active_since` pochodzą wyłącznie z `.github/repo-standard.json` (walidator `common/params.js`); w kodzie i w YAML nie ma wartości domyślnych. Pusty napis `""` w polu oznacza świadome wyłączenie tej jednej części: kod wyjścia 0, zero zmian, linia logu `wylaczone parametrem <pole>`. Brak pola, `null`, zły format albo nieistniejąca data to kod 2 i zero zmian.

**Triage.** Tabela „Triage” jest czytana z `bodyHTML`, czyli z HTML-a wyrenderowanego przez GitHuba, nie z surowego Markdowna. Wymagane rodziny to P, T i area; etykieta musi pasować dokładnie (`P0`-`P4`, `T1`-`T3`, `area:*`). Etykieta `needs-triage` jest nakładana i zdejmowana przez bramkę.

**Czytnik HTML-a.** Jeden przebieg po znakach ze stosem otwartych elementów, bez wyrażeń regularnych z cofaniem. Tekst pod dowolnie zagnieżdżonym `del`, `s` albo `strike` jest ukryty. Czego czytnik nie rozumie, to błąd z kodem (fail-closed): `niezamkniety-znacznik`, `niezamkniety-komentarz`, `nieoczekiwany-znak`, `za-duzo-znakow`, `za-duzo-tokenow`, `zle-zamkniecie`, `niezamkniety-element`, `tag-spoza-listy`, `atrybut-ukrywajacy`. W komórkach etykiety i wartości obowiązuje lista dozwolonych tagów i odrzucenie atrybutów `hidden`, `style`, `aria-hidden`. Encje są rozwijane po rozbiorze.

**Kontrola etykiet przed zmianą.** Wymagane są etykiety audytu (gdy audyt jest aktywny), `needs-triage` (gdy triage jest aktywny) i etykiety wskazane w tabeli. Brak którejkolwiek to STOP: kod 2, lista nazw w komunikacie, zero zmian. Bramka nigdy nie tworzy etykiet. Odczyt etykiet zgłoszenia ma limit `labels(first:100)`.

**Wartości `quality_gate`** w pliku parametrów tego repozytorium: workflow `ci.yml`, joby `tests`, `privacy`, `secret-scan`, wymagane przy `pull_request`, `push` i `workflow_dispatch`.

**Konwencje.** Podpisy i nagłówki tabeli Triage są po polsku (nazwy to część kontraktu). Etykiet `audit:*` nie ustawia się ręcznie.

**Uruchomienie i testy.**

```bash
node .github/standard/audit/issue-audit-gate.js --issue 5 --dry-run
node --test "tests/*.test.js"
```

Testy obejmują czytnik HTML-a (w tym model wyczerpujący wszystkie ciągi tokenów do długości 6), reconciler, parametry, kontrolę etykiet, log pominiętych werdyktów i kontrakt workflow. Pomiar mutacyjny jest wykonywany Strykerem na kopii poza repozytorium.

## Etykiety

Pliki: `.github/standard/labels/labels-core.json` (rdzeń), `.github/standard/labels/labels_sync.js` (walidacja, plan, synchronizacja) i `.github/workflows/labels-sync.yml`. Wszystkie trzy są `exact` i `critical` w manifeście. Node.js, wyłącznie biblioteka standardowa, bez zależności.

**Rdzeń i część lokalna.** Rdzeń to etykiety, na których opiera się proces: priorytety `P0`-`P4`, ryzyka `T1`-`T3`, `blocked`, `needs-triage`, `by:agent` i `audit:pending`, `audit:changes`, `audit:ok`. Konsument kopiuje je bez zmian (opisy w ASCII z łącznikiem `-`, kolory stałe w rodzinach). Resztę opisuje lokalny plik `.github/labels.json`: `repo`, obszary `area:*` (co najmniej jeden), własne rodziny, klasyfikacja etykiet cudzych (`system` dla domyślnych etykiet GitHuba, `foreign` dla etykiet integracji) i `migrations`. Plik lokalny NIE jest wpisem `manifest.json`: `apply` go nie tworzy, nie nadpisuje i nie sprawdza jego sumy, a `check --self` go nie liczy do rozjazdu. Jego kontrakt (schemat, brak redefinicji nazw rdzenia, spójność prefiksów i kolorów rodzin, minimum jedna etykieta `area:`, `repo` zgodne z `GITHUB_REPOSITORY`) sprawdza `labels_sync.js check`, a brak pliku to błąd. Rozjazd rdzenia wykrywa `standard_sync.js check`; zmiany pliku lokalnego nie wykrywa, bo ta część należy do konsumenta. Przykład minimalnego pliku lokalnego: [`.github/labels.json`](.github/labels.json) w tym repozytorium.

```json
{
  "schema": 1,
  "repo": "wlasciciel/nazwa",
  "families": { "area": { "prefix": "area:", "color": "0E8A16" } },
  "labels": [ { "name": "area:docs", "color": "0E8A16", "family": "area", "description": "Dokumentacja." } ],
  "system": ["bug", "documentation", "enhancement"],
  "foreign": [],
  "migrations": { "rename": [], "delete": [] }
}
```

**Polecenia.**

```bash
node .github/standard/labels/labels_sync.js check
node .github/standard/labels/labels_sync.js diff [--live plik.json] [--strict]
node .github/standard/labels/labels_sync.js sync [--dry-run]
```

`check` działa offline. `diff` porównuje manifest z żywym stanem (z `--strict` rozjazd to kod 1). `sync` zapisuje zmiany; `--dry-run` tylko planuje i odczytuje użycie etykiet do usunięcia. Repozytorium: `--repo` albo `GITHUB_REPOSITORY`. Kody wyjścia: 0 zgodne, 1 rozjazd albo odmowa (konflikt nazw, etykieta w użyciu), 2 błąd działania (zły manifest, brak pliku, błąd sieci albo uprawnień). Walidacja i kontrole przed zapisem nie zostawiają żadnego zapisu.

**Walidacja.** Nazwa do 50 znaków, opis (niepusty) do 100, kolor 6 znaków hex, tekst w NFC, bez znaków sterujących, bez U+FFFD i bez pauz w opisie; unikalność bez względu na wielkość liter; prefiks rodziny należy tylko do jej etykiet; etykieta lokalna nie może mieć nazwy rdzenia ani prefiksu rodziny rdzenia (`audit:`, `by:`); nieznane pola w plikach to błąd.

**Etykiety nieznane.** Etykieta w repozytorium spoza rdzenia, pliku lokalnego, `system` i `foreign` jest niesklasyfikowana: łamie zgodność (kod 1 z `--strict` i po zapisie), ale nigdy nie jest usuwana ani zmieniana. Etykieta z `system` albo `foreign` nieobecna w repozytorium jest tylko odnotowana.

**Zapis w dwóch fazach.** API GitHuba nie jest transakcyjne, więc skrypt nie obiecuje atomowości, tylko bezpieczny przebieg i możliwość wznowienia. Faza 1 (bez zapisu): walidacja, odczyt stanu, pełny plan, sprawdzenie konfliktów, odczyt użycia każdej etykiety do usunięcia i próba zapisu (aktualizacja istniejącej etykiety do jej własnych wartości). Faza 2: operacje w kolejności zmiana nazwy, utworzenie, poprawka, usunięcie, z linią logu dla każdej. Pierwszy błąd (np. 429, 403, 5xx) przerywa zapis kodem 2 i usunięcia nie są wykonywane. Ponowny bieg liczy plan od nowa ze stanu żywego, więc nie dubluje etykiet. Po zapisie skrypt czyta stan jeszcze raz i porównuje z manifestem; rozjazd to kod 1. Odczyt etykiet i zgłoszeń stronicuje do końca (`gh api --paginate`): błąd na dowolnej stronie albo wiersz, którego nie da się odczytać, to kod 2.

**Rdzeń nieusuwalny, usuwanie lokalne.** Wpis w `migrations.delete` albo `migrations.rename` z nazwą rdzenia (w dowolnej wielkości liter) jest błędem walidacji, a wpis w `delete` musi być napisem: nie ma żadnej flagi „usuń mimo użycia”. Zmiana albo usunięcie etykiety rdzenia wymaga nowego wydania wzorca w wersji MAJOR, osobnego zgłoszenia i dowodu zachowania historii audytu. Usunięcie etykiety lokalnej wykonuje się tylko wtedy, gdy żadne zgłoszenie ani PR (wszystkie stany) jej nie ma: odczyt w fazie 1 i ponownie tuż przed usunięciem; etykieta w użyciu zatrzymuje całość (kod 1). Usunięcie etykiety w użyciu to osobna decyzja właściciela i ręczne zdjęcie przypisań poza skryptem.

**Workflow.** `push` na domyślną gałąź (zmiany manifestu etykiet, skryptu albo workflow) uruchamia zapis; `pull_request` uruchamia tylko `check` offline, bez tokenu; `workflow_dispatch` ma `dry_run` domyślnie `true`. Zapis jest warunkiem joba na `refs/heads/main` i bez `dry_run`; inne uruchomienia biegną jako plan z `issues: read`. `permissions: {}` na poziomie workflow, minimalne uprawnienia w jobach, akcje na pełnym SHA, `persist-credentials: false`, `ubuntu-24.04`, token tylko przez `env`.

**Zgodność z bramką audytu.** Bramka audytu nie tworzy etykiet i zatrzymuje się, gdy brakuje `audit:*`, `needs-triage` albo etykiet z tabeli „Triage”. Kolejność u konsumenta: najpierw synchronizacja etykiet, potem włączenie bramki. `area:*` z tabeli „Triage” musi istnieć w pliku lokalnym. Test zgodności pilnuje, żeby etykiety wymagane przez bramkę były w rdzeniu.

**Uruchomienie testów.**

```bash
node --test "tests/labels-*.test.js"
```

Testy używają atrapy klienta GitHub i danych syntetycznych, bez sieci i bez `gh`; testy `apply` używają lokalnego serwera https jak pozostałe testy wzorca. Pomiar mutacyjny skryptu jest wykonywany Strykerem.

## Zaufanie do kodu bramek

- `review-gate` i `standard-drift` biegną na `pull_request_target` z kodem z domyślnej gałęzi. HEAD PR jest wyłącznie danymi, nigdy nie jest wykonywany.
- Zaufane wartości `standard.version`, `standard.sha` i ścieżkę manifestu weryfikator czyta z pliku parametrów na domyślnej gałęzi (SHA bazy PR), nie z HEAD PR.
- Aktualizacja wzorca to osobna operacja: nowy SHA obowiązuje dla PR tylko wtedy, gdy jest commitem tagu wydania tego repozytorium nowszego niż wersja bazy, a werdykt audytu zawiera linię `Wzorzec: <wersja> <pełny SHA>`.
- Podpis z dopiskiem roli jest ważny tylko w ostatniej niepustej linii, a strona musi zgadzać się z aplikacją, przez którą powstał komentarz. To protokół, nie dowód kryptograficzny: wszystko idzie z jednego konta.

## Runnery

Każdy workflow wyzwalany przez `pull_request` albo `pull_request_target` ma `runs-on` jako literalną etykietę runnera GitHub-hosted. Własne runnery mają być niedostępne dla kodu PR (wymóg wobec ustawień organizacji, którego to repozytorium samo nie weryfikuje); wolno je wskazać tylko w workflow wyzwalanych zdarzeniami z kodem z domyślnej gałęzi. Kontrola polityki w repozytorium jest warstwą dodatkową; barierą prewencyjną są ustawienia grup runnerów w organizacji ([Secure use](https://docs.github.com/en/actions/reference/security/secure-use)).

## Adopcja (po wydaniu `v1.0.0`)

1. Skopiuj wydanie: raz pobierz ręcznie `.github/standard/standard_sync.js` i `.github/standard/common/params.js` z wydania po pełnym SHA commita (sprawdź sumy z `manifest.json`), a potem uruchom `node .github/standard/standard_sync.js apply --version v1.0.0`; skrypt zastąpi te pliki zweryfikowanymi.
2. Uzupełnij `.github/repo-standard.json` (daty aktywacji, listy jobów strażnika, dodatkowe ścieżki bramki przeglądu).
3. Dopisz do ochrony domyślnej gałęzi wymagane kontrole `quality-gate`, `review-gate` i `secret-scan`.
4. Włącz `standard-drift.yml` i sprawdź, że kontrola jest zielona na czystej kopii.
5. Dodaj do konsumenta `.gitattributes` z wpisem `* text=auto eol=lf` (jak tutaj); bez niego checkout z końcami CRLF na Windows zepsuje sumy `exact`.

## Zasady tego repozytorium

- Repozytorium jest publiczne. Nie ma w nim danych klientów ani kandydatów, nazw klientów, danych osobowych, kluczy, domen wewnętrznych, identyfikatorów instalacji ani odnośników do prywatnych zasobów. Testy używają wyłącznie danych syntetycznych.
- Od ustawienia ochrony domyślnej gałęzi każda zmiana idzie przez PR z audytem strony przeciwnej; zmiana plików bramek wymaga jawnej akceptacji w werdykcie.
- Licencja: [MIT](LICENSE). Narzędzia pobierane w trakcie pracy (gitleaks, actionlint, release-drafter) nie wchodzą do repozytorium: [THIRD_PARTY.md](THIRD_PARTY.md).
