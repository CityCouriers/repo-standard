# Rejestr narzędzi i praw

Kod i dokumentacja tego repozytorium są własnością CityCouriers i wydawane na licencji MIT ([LICENSE](LICENSE)). Poniższe narzędzia są pobierane w czasie pracy przepływów w wersjach i z sumami kontrolnymi zapisanymi w workflow. Nie wchodzą do repozytorium i nie są tu redystrybuowane.

| narzędzie | użycie | licencja | wersja i suma |
| --- | --- | --- | --- |
| gitleaks | skan sekretów | MIT | wersja i SHA-256 w workflow `secret-scan` (od `v1.0.0`) |
| actionlint | kontrola składni workflow | MIT | wersja i SHA-256 w workflow `workflow-lint` (od `v1.0.0`) |
| release-drafter | szkice wydań w konsumentach | MIT | pełny SHA akcji w workflow (od `v1.0.0`) |
| actions/checkout, actions/setup-python | pobranie repozytorium, interpreter | MIT | pełny SHA akcji z komentarzem wersji (od `v1.0.0`) |

Wersje, sumy i licencje uzupełnia wydanie `v1.0.0` razem z workflow; rejestr jest sprawdzany przy każdym wydaniu.
