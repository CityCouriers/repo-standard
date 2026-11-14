# Rejestr narzędzi i praw

Kod i dokumentacja tego repozytorium są własnością CityCouriers i wydawane na licencji MIT ([LICENSE](LICENSE)). Poniższe narzędzia są pobierane w czasie pracy przepływów w wersjach i z sumami kontrolnymi zapisanymi w workflow. Nie wchodzą do repozytorium i nie są tu redystrybuowane. Skrypty wzorca używają wyłącznie biblioteki standardowej Node.js (bez zależności z rejestru pakietów).

Skrypt `scripts/ci/privacy-scan.sh` i job `secret-scan` pochodzą z publicznego repozytorium `CityCouriers/pc` (commit `2538247b1`, ta sama organizacja i licencja MIT), ze zmianami wymienionymi w opisie pull requesta wprowadzającego.

| narzędzie | użycie | licencja | wersja i suma |
| --- | --- | --- | --- |
| gitleaks | skan sekretów | MIT | wersja 8.30.1 i SHA-256 w workflow `secret-scan` |
| actionlint | kontrola składni workflow | MIT | wersja i SHA-256 w workflow `workflow-lint` (od `v1.0.0`) |
| release-drafter | szkice wydań w konsumentach | MIT | pełny SHA akcji w workflow (od `v1.0.0`) |
| actions/checkout, actions/setup-node | pobranie repozytorium, środowisko Node 22 | MIT | pełny SHA akcji z komentarzem wersji w workflow `ci.yml` |

Wersje, sumy i licencje pozostałych narzędzi uzupełnia wydanie `v1.0.0` razem z workflow; rejestr jest sprawdzany przy każdym wydaniu.
