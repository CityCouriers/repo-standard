#!/usr/bin/env bash
# Skan prywatności (AC5 z nexus#2555): w publicznym repo nie może być ścieżek z maszyn autorów,
# adresów e-mail ani nazw kont. Skaner sekretów (gitleaks) tego nie pokrywa. Skan nie zastępuje
# ręcznego przeglądu pochodzenia i licencji przenoszonego kodu.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

self="scripts/ci/privacy-scan.sh"
status=0

mapfile -t files < <(git ls-files --cached --others --exclude-standard | grep -v -x -e "$self" -e 'composer.lock')

scan() {
    local label="$1" pattern="$2" hits
    hits="$(grep -n -E -I -- "$pattern" "${files[@]}" 2>/dev/null || true)"
    if [ -n "$hits" ]; then
        echo "BŁĄD [$label]:"
        echo "$hits"
        status=1
    fi
}

scan "ścieżka Windows" '[A-Za-z]:[\\/](Users|Projekty|wamp64?|Temp|Documents)'
scan "katalog domowy" '(^|[^A-Za-z0-9_.-])/(home|Users)/[A-Za-z0-9_.-]+/'

emails="$(grep -n -E -I -o -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "${files[@]}" 2>/dev/null \
    | grep -v -i -E '(noreply|no-reply|@users\.noreply\.github\.com|@example\.(com|org|net)|@anthropic\.com)' || true)"
if [ -n "$emails" ]; then
    echo "BŁĄD [adres e-mail]:"
    echo "$emails"
    status=1
fi

if [ "$status" -eq 0 ]; then
    echo "OK: brak ścieżek maszyn, katalogów domowych i adresów e-mail w ${#files[@]} plikach."
fi

exit "$status"
