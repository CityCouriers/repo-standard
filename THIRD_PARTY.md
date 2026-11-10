# Rejestr narzędzi i praw

Kod i dokumentacja tego repozytorium są własnością CityCouriers i wydawane na licencji MIT ([LICENSE](LICENSE)). Poniższe narzędzia są (albo, dla pozycji oznaczonych „docelowo”, będą po dodaniu workflow w kolejnych PR-ach) pobierane w czasie pracy przepływów w wersjach i z sumami kontrolnymi zapisanymi w workflow. Nie wchodzą do repozytorium i nie są tu redystrybuowane.

| narzędzie | użycie | licencja | wersja i suma |
| --- | --- | --- | --- |
| gitleaks | skan sekretów | MIT | docelowo: wersja i SHA-256 w workflow `secret-scan` |
| actionlint | kontrola składni workflow | MIT | docelowo: wersja i SHA-256 w workflow `workflow-lint` |
| release-drafter | szkice wydań w konsumentach | MIT | docelowo: pełny SHA akcji w workflow |
| actions/checkout, actions/setup-python | pobranie repozytorium, interpreter | MIT | pełny SHA akcji z komentarzem wersji (już w `ci.yml`) |

Wersje, sumy i licencje uzupełnia wydanie `v1.0.0` razem z workflow; rejestr jest sprawdzany przy każdym wydaniu.
