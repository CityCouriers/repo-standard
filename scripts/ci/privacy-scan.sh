#!/usr/bin/env bash
# Skan prywatności: w publicznym repo nie może być ścieżek z maszyn autorów, adresów e-mail,
# identyfikatorów zgłoszeń w innych repozytoriach ani zadanych nazw (klientów, prywatnych repozytoriów).
# Skaner sekretów (gitleaks) tego nie pokrywa. Skan nie zastępuje ręcznego przeglądu pochodzenia
# i licencji przenoszonego kodu.
#
# Użycie:
#   bash scripts/ci/privacy-scan.sh [--log ZAKRES]
#
#   --log ZAKRES  dodatkowo skanuje komunikaty i metadane commitów z `git log ZAKRES` (np. origin/main..HEAD).
#
# Zmienna środowiskowa PRIVACY_PATTERNS_FILE wskazuje plik spoza repozytorium z dodatkowymi wzorcami
# (jeden wzorzec rozszerzony ERE w wierszu, `#` zaczyna komentarz, wielkość liter bez znaczenia). Wzorce
# nie trafiają do Git ani do wyjścia skanu: trafienie jest raportowane jako plik:wiersz, bez treści.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

self="scripts/ci/privacy-scan.sh"
status=0
log_range=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --log)
            [ "$#" -ge 2 ] || { echo "BŁĄD: --log wymaga zakresu."; exit 2; }
            log_range="$2"
            shift 2
            ;;
        *)
            echo "BŁĄD: nieznany argument: $1"
            exit 2
            ;;
    esac
done

patterns_clean=""
cleanup() { [ -n "$patterns_clean" ] && rm -f "$patterns_clean"; }
trap cleanup EXIT

if [ -n "${PRIVACY_PATTERNS_FILE:-}" ]; then
    if [ ! -r "$PRIVACY_PATTERNS_FILE" ]; then
        echo "BŁĄD: PRIVACY_PATTERNS_FILE wskazuje plik, którego nie da się odczytać."
        exit 2
    fi
    patterns_clean="$(mktemp)"
    # Bez pustych wierszy (pusty wzorzec pasuje do wszystkiego), komentarzy i znaków CR.
    tr -d '\r' < "$PRIVACY_PATTERNS_FILE" | grep -v -E '^[[:space:]]*(#|$)' > "$patterns_clean" || true
    if [ ! -s "$patterns_clean" ]; then
        echo "BŁĄD: plik wzorców z PRIVACY_PATTERNS_FILE nie zawiera żadnego wzorca."
        exit 2
    fi
fi

mapfile -t files < <(git ls-files --cached --others --exclude-standard | grep -v -x -e "$self")

windows_path='[A-Za-z]:[\\/](Users|Projekty|wamp64?|Temp|Documents)'
home_dir='(^|[^A-Za-z0-9_.-])/(home|Users)/[A-Za-z0-9_.-]+/'
issue_ref='[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+'
issue_url='github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(issues|pull)/[0-9]+'
email_re='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
email_ok='(noreply|no-reply|@users\.noreply\.github\.com|@example\.(com|org|net)|@anthropic\.com)'

scan() {
    local label="$1" pattern="$2" hits
    hits="$(grep -n -E -I -- "$pattern" "${files[@]}" 2>/dev/null || true)"
    if [ -n "$hits" ]; then
        echo "BŁĄD [$label]:"
        echo "$hits"
        status=1
    fi
}

scan "ścieżka Windows" "$windows_path"
scan "katalog domowy" "$home_dir"
scan "identyfikator zgłoszenia" "$issue_ref"
scan "adres zgłoszenia lub PR" "$issue_url"

emails="$(grep -n -E -I -o -- "$email_re" "${files[@]}" 2>/dev/null \
    | grep -v -i -E "$email_ok" || true)"
if [ -n "$emails" ]; then
    echo "BŁĄD [adres e-mail]:"
    echo "$emails"
    status=1
fi

# Wzorce zewnętrzne: raportujemy tylko plik:wiersz (treść mogłaby ujawnić wzorzec).
if [ -n "$patterns_clean" ]; then
    external="$(grep -n -E -I -i -f "$patterns_clean" -- "${files[@]}" 2>/dev/null | cut -d: -f1,2 || true)"
    if [ -n "$external" ]; then
        echo "BŁĄD [wzorzec zewnętrzny]: trafienia (plik:wiersz, treść ukryta):"
        echo "$external"
        status=1
    fi
fi

# Komunikaty i metadane commitów (autor, committer, treść).
if [ -n "$log_range" ]; then
    if ! log_text="$(git log --format='%an%n%ae%n%cn%n%ce%n%B' "$log_range" 2>/dev/null)"; then
        echo "BŁĄD: git log nie przyjął zakresu."
        exit 2
    fi
    log_hits=""
    add_hit() { log_hits="${log_hits}${1}"$'\n'; }
    printf '%s\n' "$log_text" | grep -q -E -- "$issue_ref" && add_hit "identyfikator zgłoszenia"
    printf '%s\n' "$log_text" | grep -q -E -- "$issue_url" && add_hit "adres zgłoszenia lub PR"
    printf '%s\n' "$log_text" | grep -q -E -- "$windows_path" && add_hit "ścieżka Windows"
    printf '%s\n' "$log_text" | grep -q -E -- "$home_dir" && add_hit "katalog domowy"
    if printf '%s\n' "$log_text" | grep -E -o -- "$email_re" | grep -v -i -E "$email_ok" | grep -q .; then
        add_hit "adres e-mail"
    fi
    if [ -n "$patterns_clean" ] && printf '%s\n' "$log_text" | grep -q -E -i -f "$patterns_clean"; then
        add_hit "wzorzec zewnętrzny (treść ukryta)"
    fi
    if [ -n "$log_hits" ]; then
        echo "BŁĄD [commity ${log_range}]: w komunikatach lub metadanych wykryto:"
        printf '%s' "$log_hits"
        status=1
    fi
fi

if [ "$status" -eq 0 ]; then
    echo "OK: brak ścieżek maszyn, katalogów domowych, adresów e-mail i identyfikatorów zgłoszeń w ${#files[@]} plikach."
fi

exit "$status"
