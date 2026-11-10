# repo-standard

> **Status: w budowie, przed pierwszym wydaniem.** Gotowe w `main`: `standard_sync.py` (`check`, `apply`), walidator pliku parametrów, `manifest.json` (na razie tylko te dwa skrypty), narzędzie wydawcy `scripts/build_manifest.py`, testy i workflow `ci.yml` (testy oraz `check --self`). Opisy przepływów, bramek i kontroli poniżej (w tym `review-gate`, `standard-drift`, protokół `Wzorzec:`, sprawdzanie nowszego wydania) są docelowe: dochodzą z kolejnymi PR-ami. Kolejne elementy z tabeli poniżej dochodzą osobnymi PR-ami, a `v1.0.0` powstaje po ostatnim z nich. Do wydania niczego stąd nie wolno kopiować do produkcyjnych repozytoriów.

Docelowo: wspólne przepływy GitHub Actions, skrypty bramek i szablony dla repozytoriów CityCouriers. Każdy element ma mieć jedną wersję wzorcową, a repozytorium, które go używa, kopiuje ją bez zmian i trzyma jeden mały plik parametrów. Rozjazd kopii od wzorca ma wykrywać automat.

## Zasada działania (docelowa)

1. Wzorzec jest wydawany z tagiem (`v1.0.0`, `v1.1.0`, ...). Wydanie zawiera `manifest.json`: ścieżkę, rodzaj i sumę SHA-256 każdego pliku.
2. Repozytorium-konsument kopiuje pliki wydania skryptem `standard_sync.py apply`. Skrypt pobiera manifest i pliki z tego publicznego repozytorium po pełnym SHA commita wydania, bez tokenu, i zapisuje wersję oraz SHA w pliku parametrów konsumenta.
3. Workflow `standard-drift.yml` (też kopiowany) biegnie w soboty, przy PR zmieniającym `.github/**` i ręcznie. Porównuje pliki z manifestem wersji z pliku parametrów, sprawdza wygasłe odstępstwa i czy jest nowsze wydanie. Przy PR i przy uruchomieniu ręcznym jest czerwony przy rozjeździe; w sobotę zakłada albo aktualizuje jedno zgłoszenie „Rozjazd wzorca” z etykietami poza zakresem bramki audytu (`P3`, `T1`, `area:process`).
4. Aktualizacja to zwykły PR w repozytorium-konsumencie, z jego własnym audytem i CI. Kontrola nie zapisuje do plików repozytorium: token `GITHUB_TOKEN` nie ma uprawnienia do zmiany plików w `.github/workflows` ([lista uprawnień](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)), więc automatyczna synchronizacja wymagałaby dodatkowego sekretu, którego świadomie nie wprowadzamy.

Przepływy wielokrotnego użytku (`workflow_call`) i, o ile plan organizacji pozwala, reguła organizacji „Require workflows” są opcjami na kolejne wersje, po pilocie.

## Elementy wzorca (zakres `v1.0.0`)

Wersja wzorcowa każdego elementu została wybrana według zachowania, nie według języka. Skrypty są w Pythonie (biblioteka standardowa, bez zależności), wersja interpretera jest zapisana w workflow.

| element | co robi | parametr lokalny |
| --- | --- | --- |
| bramka audytu zgłoszeń `audit:*` | stan audytu zgłoszeń w zakresie (priorytet P0-P2 albo ryzyko T2/T3): wyłącznie strona przeciwna autorowi wydaje ważny werdykt `/audit-ok` albo `/audit-changes`; autor jest ustalany z trzech zgodnych sygnałów (podpis, etykieta `by:agent`, aplikacja, przez którą powstała treść); edycja treści albo komendy unieważnia werdykt | `audit.active_since` |
| triage | uzupełnia brakujące P, T i area z tabeli „Triage” w treści zgłoszenia, nakłada i zdejmuje `needs-triage`; wymagane rodziny są stałe: P, T, area | `triage.active_since` |
| powiązanie PR ze zgłoszeniem | pierwsza linia opisu PR to `Fixes #n` albo `Refs #n`; zgłoszenie musi istnieć i być otwarte; ukryte słowa zamykające są błędem; PR Dependabota jest wyjątkiem | brak |
| strażnik wersji roboczej | job zbiorczy: PR w Draft jest zawsze czerwony; poza Draft wymagane joby muszą mieć `success`, pozostałe `skipped`; brak wyniku albo wynik nieznany jest czerwony | `quality_gate.jobs`, `quality_gate.required` |
| bramka przeglądu `review-gate` | zielona, gdy ostatni ważny werdykt strony przeciwnej wskazuje pełny SHA HEAD, powiązane zgłoszenia mają `audit:ok`, a zmiana plików bramek ma linię „Zmiana bramki: zaakceptowana”; kod z domyślnej gałęzi | `review_gate.protected_paths` |
| etykiety | manifest standardu (`labels.standard.json`) scalany z lokalnym `labels.json`; synchronizacja zapisuje tylko z domyślnej gałęzi i weryfikuje stan po zmianie; etykieta spoza obu plików łamie zgodność | lokalny `labels.json` |
| skan sekretów `secret-scan` | gitleaks z przypiętą wersją i sumą SHA-256: zakres PR, push, ręczny `--all` i bieg tygodniowy `--all` | opcjonalny `.gitleaks.toml` |
| kontrola workflow `workflow-lint` | actionlint z przypiętą wersją i sumą; osobny workflow z filtrem ścieżek, niewymagany | brak |
| polityka workflow | wszystkie `uses:` spoza repozytorium na pełnym SHA z komentarzem wersji, `permissions: {}` na poziomie workflow, literalny runner GitHub-hosted dla wyzwalaczy PR | brak |
| Dependabot | blok `github-actions`: `weekly`, sobota, grupowanie, etykieta `dependencies` | inne ekosystemy dopisuje konsument |
| release-drafter | autolabeler pomija Draft i forki | lokalny `release-drafter.yml` (kategorie) |
| kontrola rozjazdu | `standard_sync.py`, `standard-drift.yml` | `standard`, `overrides` |

Elementy zależne od repozytorium (treść szablonów, sekcje dowodów w PR, łańcuch narzędzi jakości, budowa wydań, workflow lokalne) zostają w konsumencie. Standard dostarcza tylko szkielet i test spójności: `config.yml` szablonów zgłoszeń, stopkę podpisu, pierwszą linię `Fixes`/`Refs` w szablonie PR oraz test zgodności jobu `quality-gate` z parametrami.

## Układ repozytorium i narzędzie `standard_sync.py`

Układ plików wzorca jest taki sam jak w konsumencie: skrypty bramek leżą w `.github/standard/<element>/`, wspólne moduły w `.github/standard/common/`, a workflow w `.github/workflows/`. Pliki, które konsument dostaje jako szablon (`seed`) albo które w repozytorium wzorca mają inną treść niż w konsumencie, leżą pod `seeds/` i są wskazane polem `source` w manifeście. Testy (`tests/`) i narzędzia wydawcy (`scripts/`) nie są kopiowane.

`python .github/standard/standard_sync.py <polecenie>` używa wyłącznie biblioteki standardowej Pythona:

| polecenie | działanie |
| --- | --- |
| `apply --version v1.0.0` (albo `--sha <pełny SHA>`) | zamienia tag na SHA commita wydania, pobiera `manifest.json` i pliki po tym SHA, sprawdza sumy SHA-256 i dopiero potem zapisuje wszystko; w pliku parametrów ustawia `standard.version` i `standard.sha`. Pliki z ważnym odstępstwem pomija, istniejące szablony `seed` zostawia, w istniejącym pliku `block` podmienia tylko blok. `--dry-run` niczego nie zapisuje. |
| `check` | porównuje pliki konsumenta z manifestem wersji z pliku parametrów; kod 0 zgodne, 1 rozjazd, 2 błąd działania (sieć, zły manifest, zły plik parametrów). Odstępstwa: wygasłe, dłuższe niż 90 dni, dla pliku krytycznego, spoza manifestu albo dla pliku bez `overridable` są rozjazdem. |
| `check --tree REV --params PLIK` | tryb dla `pull_request_target`: pliki konsumenta czyta z commita `REV` (`git cat-file`, bez checkoutu i bez wykonania), a przypięcie wzorca (`standard.version`, `standard.sha`) z zaufanego pliku `PLIK` (domyślna gałąź), nie z PR; `--tree` bez `--params` to błąd (kod 2). Odstępstwa (`overrides`) czytane są z `REV`, więc zmiana przypięcia w PR jest rozjazdem, a nowe odstępstwo chroni wymóg linii „Zmiana bramki: zaakceptowana” w `review-gate`. |
| `check --verify-issues` | dodatkowo sprawdza przez API (token z `GH_TOKEN` albo `GITHUB_TOKEN`; wymaga `GITHUB_REPOSITORY`), że zgłoszenie każdego odstępstwa należy do repozytorium konsumenta, jest otwarte i ma `audit:ok`; brak odpowiedzi API jest rozjazdem. |
| `check --self` | tylko w repozytorium wzorca: manifest lokalny względem własnych plików (dla `seed` także suma źródła szablonu) i kompletność wpisów dla `.github/standard/`. |

Blok (`block`) to tekst między liniami `# repo-standard:begin <id>` i `# repo-standard:end <id>` (po jednej parze w pliku); porównywany jest tylko on, reszta pliku (np. kolejne ekosystemy w `dependabot.yml`) jest lokalna. Końce linii muszą być `LF`: sumy liczone są z bajtów.

Wpis manifestu ma pola: `path`, `kind` (`exact`, `block`, `seed`, `param`), `sha256` (pliku, bloku albo źródła szablonu), `critical`, `overridable`, `source`, `block`, `markers` (wymagane znaczniki szablonu), `skeleton` (nagłówek pliku z blokiem tworzonego od zera). Plik krytyczny jest zawsze `exact` i nie ma `overridable`. Wydawca odświeża sumy poleceniem `python scripts/build_manifest.py` i sprawdza je `check --self`.

Szczegóły zachowania: `check` zgłasza rozjazd także wtedy, gdy wersja manifestu pobranego po `standard.sha` różni się od `standard.version`; termin odstępstwa liczy się od dnia kontroli (najwyżej 90 dni do `until`), nie od dnia wpisu; `apply` kończy się kodem 2 i niczego nie zapisuje, gdy istniejący plik `block` nie ma znaczników, gdy tag wskazuje manifest innej wersji, gdy cel koliduje z istniejącym plikiem lub katalogiem albo przechodzi przez dowiązanie symboliczne; opcja `apply --repo` służy do prób na kopii wzorca; ścieżki manifestu nie mogą zawierać segmentu `.git`. Walidator pliku parametrów i manifestu odrzuca nieznane i brakujące klucze oraz powtórzone klucze JSON; wymagane pola wpisu zależą od rodzaju (`param` bez `sha256`, `block` wymaga `block`, `seed` wymaga niepustych `markers`). Połączenia sieciowe idą wyłącznie przez https, a przekierowanie poza ten sam host jest błędem.

## Plik parametrów `.github/repo-standard.json`

Jedyny plik konsumenta, którego standard nie przejmuje: `apply` zmienia w nim wyłącznie `standard.version` i `standard.sha` (przepisując formatowanie JSON), a resztę wartości prowadzi konsument. Gdy pliku brak, `apply` tworzy szkielet z pustymi datami aktywacji (bramki nieaktywne) i placeholderem `jobs`, który konsument ma uzupełnić.

```json
{
  "schema": 1,
  "standard": { "version": "v1.0.0", "sha": "<pełny SHA 40 znaków>" },
  "audit": { "active_since": "RRRR-MM-DDTGG:MM:SSZ" },
  "triage": { "active_since": "RRRR-MM-DDTGG:MM:SSZ" },
  "quality_gate": { "workflow": "quality.yml", "jobs": ["..."], "required": { "pull_request": ["..."], "push": ["..."], "workflow_dispatch": ["..."] } },
  "review_gate": { "protected_paths": ["pyproject.toml"] },
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

## Zaufanie do kodu bramek (docelowe; w `main` jest na razie `standard_sync.py`)

- `review-gate` i `standard-drift` biegną na `pull_request_target` z kodem z domyślnej gałęzi. HEAD PR jest wyłącznie danymi, nigdy nie jest wykonywany.
- Zaufane wartości `standard.version` i `standard.sha` weryfikator czyta z pliku parametrów na domyślnej gałęzi (SHA bazy PR), nie z HEAD PR; ścieżka manifestu i repozytorium wzorca są stałymi kodu.
- Aktualizacja wzorca to osobna operacja: nowy SHA obowiązuje dla PR tylko wtedy, gdy jest commitem tagu wydania tego repozytorium nowszego niż wersja bazy, a werdykt audytu zawiera linię `Wzorzec: <wersja> <pełny SHA>`.
- Podpis z dopiskiem roli jest ważny tylko w ostatniej niepustej linii, a strona musi zgadzać się z aplikacją, przez którą powstał komentarz. To protokół, nie dowód kryptograficzny: wszystko idzie z jednego konta.

## Runnery

Każdy workflow wyzwalany przez `pull_request` albo `pull_request_target` ma `runs-on` jako literalną etykietę runnera GitHub-hosted. Własne runnery mają być niedostępne dla kodu PR (wymóg wobec ustawień organizacji, którego to repozytorium samo nie weryfikuje); wolno je wskazać tylko w workflow wyzwalanych zdarzeniami z kodem z domyślnej gałęzi. Kontrola polityki w repozytorium jest warstwą dodatkową; barierą prewencyjną są ustawienia grup runnerów w organizacji ([Secure use](https://docs.github.com/en/actions/reference/security/secure-use)).

## Adopcja (po wydaniu `v1.0.0`)

1. Skopiuj ręcznie `.github/standard/standard_sync.py` i `.github/standard/common/params.py` z wydania, a potem z korzenia repozytorium uruchom `python .github/standard/standard_sync.py apply --version v1.0.0`.
2. Uzupełnij `.github/repo-standard.json` (daty aktywacji, listy jobów strażnika, dodatkowe ścieżki bramki przeglądu).
3. Dopisz do ochrony domyślnej gałęzi wymagane kontrole `quality-gate`, `review-gate` i `secret-scan`.
4. Włącz `standard-drift.yml` i sprawdź, że kontrola jest zielona na czystej kopii.
5. Dodaj do konsumenta `.gitattributes` z wpisem `* text=auto eol=lf` (jak tutaj); bez niego checkout z końcami CRLF na Windows zepsuje sumy `exact`.

## Zasady tego repozytorium

- Repozytorium jest publiczne. Nie ma w nim danych klientów ani kandydatów, nazw klientów, danych osobowych, kluczy, domen wewnętrznych, identyfikatorów instalacji ani odnośników do prywatnych zasobów. Testy, gdy powstaną, używają wyłącznie danych syntetycznych.
- Od ustawienia ochrony domyślnej gałęzi każda zmiana idzie przez PR z audytem strony przeciwnej; zmiana plików bramek wymaga jawnej akceptacji w werdykcie.
- Licencja: [MIT](LICENSE). Narzędzia pobierane w trakcie pracy (gitleaks, actionlint, release-drafter) nie wchodzą do repozytorium: [THIRD_PARTY.md](THIRD_PARTY.md).
