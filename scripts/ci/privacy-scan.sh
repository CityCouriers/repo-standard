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
# (jeden wzorzec rozszerzony ERE w wierszu, `#` zaczyna komentarz, wielkość liter bez znaczenia).
#
# Wyjście publicznego logu: każda kategoria zgłasza wyłącznie plik:wiersz (dla commitów: samą kategorię),
# NIGDY wartość trafienia ani otaczający tekst. Skanowane są wszystkie śledzone i nieignorowane pliki,
# także ten skaner (wzorce są zapisane tak, że ich definicje same nie pasują).
#
# Kody wyjścia: 0 brak trafień; 1 są trafienia; 2 skanu nie da się przeprowadzić w całości
# (błąd git, nieczytelny plik, błąd grep, zły argument). Brak dowodu kompletności nigdy nie jest zielony.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

status=0
log_range=""

fail() { echo "BŁĄD: $1"; exit 2; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --log)
            [ "$#" -ge 2 ] || fail "--log wymaga zakresu."
            log_range="$2"
            shift 2
            ;;
        *)
            fail "nieznany argument: $1"
            ;;
    esac
done

patterns_raw=""
patterns_clean=""
list_file=""
cleanup() { rm -f "$patterns_raw" "$patterns_clean" "$list_file"; }
trap cleanup EXIT

if [ -n "${PRIVACY_PATTERNS_FILE:-}" ]; then
    [ -r "$PRIVACY_PATTERNS_FILE" ] || fail "PRIVACY_PATTERNS_FILE wskazuje plik, którego nie da się odczytać."
    patterns_raw="$(mktemp)" || fail "mktemp."
    patterns_clean="$(mktemp)" || fail "mktemp."
    tr -d '\r' < "$PRIVACY_PATTERNS_FILE" > "$patterns_raw" || fail "nie udało się odczytać pliku wzorców."
    # Bez pustych wierszy (pusty wzorzec pasuje do wszystkiego) i komentarzy; kod 1 = nic nie zostało.
    grep -v -E '^[[:space:]]*(#|$)' "$patterns_raw" > "$patterns_clean"
    [ "$?" -le 1 ] || fail "grep nie przetworzył pliku wzorców."
    [ -s "$patterns_clean" ] || fail "plik wzorców z PRIVACY_PATTERNS_FILE nie zawiera żadnego wzorca."
fi

# Lista plików: błąd git albo pusta lista to kod 2 (grep bez plików czytałby standardowe wejście).
list_file="$(mktemp)" || fail "mktemp."
git ls-files -z --cached --others --exclude-standard > "$list_file" 2>/dev/null || fail "git ls-files nie zwrócił listy plików."
files=()
while IFS= read -r -d '' name; do
    case "$name" in
        *:* | *$'\n'*) fail "nazwa śledzonego pliku zawiera dwukropek albo nowy wiersz: nie da się jej jednoznacznie zgłosić." ;;
    esac
    # Plik usunięty z drzewa roboczego, ale jeszcze w indeksie, nie ma treści do skanu.
    if [ ! -e "$name" ] && [ ! -L "$name" ]; then
        continue
    fi
    [ -f "$name" ] || fail "śledzony wpis nie jest zwykłym plikiem albo jest uszkodzonym dowiązaniem: $name"
    [ -r "$name" ] || fail "nieczytelny plik: $name"
    files+=("$name")
done < "$list_file"
[ "${#files[@]}" -gt 0 ] || fail "lista plików do skanu jest pusta."

windows_path='[A-Za-z]:[\\/](Users|Projekty|wamp64?|Temp|Documents)'
home_dir='(^|[^A-Za-z0-9_.-])/(home|Users)/[A-Za-z0-9_.-]+/'
issue_ref='[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+'
issue_url='github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(issues|pull)/[0-9]+'
email_re='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
email_ok='(noreply|no-reply|@users\.noreply\.github\.com|@example\.(com|org|net)|@anthropic\.com)'

# Wypisuje plik:wiersz bez treści (nazwy plików nie zawierają dwukropka, patrz wyżej).
locations_only() { cut -d: -f1,2 | sort -u; }

report() {
    local label="$1" locs="$2"
    echo "BŁĄD [$label]: trafienia (plik:wiersz, treść ukryta):"
    echo "$locs"
    status=1
}

scan() {
    local label="$1" pattern="$2" out rc locs
    out="$(grep -H -n -E -I -- "$pattern" "${files[@]}" 2>/dev/null)"; rc=$?
    case "$rc" in
        0) locs="$(printf '%s\n' "$out" | locations_only)"; report "$label" "$locs" ;;
        1) ;;
        *) fail "grep zakończył się błędem (kod $rc) przy kategorii: $label." ;;
    esac
}

scan "ścieżka Windows" "$windows_path"
scan "katalog domowy" "$home_dir"
scan "identyfikator zgłoszenia" "$issue_ref"
scan "adres zgłoszenia lub PR" "$issue_url"

out="$(grep -H -n -E -I -o -- "$email_re" "${files[@]}" 2>/dev/null)"; rc=$?
case "$rc" in
    0)
        email_locs=""
        while IFS=: read -r f l m; do
            m="${m,,}"
            [[ "$m" =~ $email_ok ]] || email_locs="${email_locs}${f}:${l}"$'\n'
        done <<< "$out"
        if [ -n "$email_locs" ]; then
            report "adres e-mail" "$(printf '%s' "$email_locs" | sort -u)"
        fi
        ;;
    1) ;;
    *) fail "grep zakończył się błędem (kod $rc) przy kategorii: adres e-mail." ;;
esac

# Wzorce zewnętrzne: raportujemy tylko plik:wiersz (treść mogłaby ujawnić wzorzec).
if [ -n "$patterns_clean" ]; then
    out="$(grep -H -n -E -I -i -f "$patterns_clean" -- "${files[@]}" 2>/dev/null)"; rc=$?
    case "$rc" in
        0) locs="$(printf '%s\n' "$out" | locations_only)"; report "wzorzec zewnętrzny" "$locs" ;;
        1) ;;
        *) fail "grep zakończył się błędem (kod $rc) przy kategorii: wzorzec zewnętrzny." ;;
    esac
fi

# Komunikaty i metadane commitów (autor, committer, treść): raportujemy tylko kategorię.
if [ -n "$log_range" ]; then
    log_text="$(git log --format='%an%n%ae%n%cn%n%ce%n%B' "$log_range" 2>/dev/null)" \
        || fail "git log nie przyjął zakresu."
    log_hits=""
    # log_has WZORZEC [opcje grep]: 0 trafienie, 1 brak, inne kody kończą skan błędem.
    log_has() {
        local pat="$1"; shift
        grep -q -E "$@" -- "$pat" <<< "$log_text"
        local c=$?
        [ "$c" -le 1 ] || fail "grep zakończył się błędem (kod $c) przy skanie commitów."
        return "$c"
    }
    log_has "$issue_ref" && log_hits="${log_hits}identyfikator zgłoszenia"$'\n'
    log_has "$issue_url" && log_hits="${log_hits}adres zgłoszenia lub PR"$'\n'
    log_has "$windows_path" && log_hits="${log_hits}ścieżka Windows"$'\n'
    log_has "$home_dir" && log_hits="${log_hits}katalog domowy"$'\n'
    mails="$(grep -E -o -- "$email_re" <<< "$log_text")"; rc=$?
    [ "$rc" -le 1 ] || fail "grep zakończył się błędem (kod $rc) przy skanie commitów."
    while IFS= read -r m; do
        [ -n "$m" ] || continue
        m="${m,,}"
        if ! [[ "$m" =~ $email_ok ]]; then
            log_hits="${log_hits}adres e-mail"$'\n'
            break
        fi
    done <<< "$mails"
    if [ -n "$patterns_clean" ]; then
        grep -q -E -i -f "$patterns_clean" <<< "$log_text"
        rc=$?
        [ "$rc" -le 1 ] || fail "grep zakończył się błędem (kod $rc) przy skanie commitów."
        [ "$rc" -eq 0 ] && log_hits="${log_hits}wzorzec zewnętrzny (treść ukryta)"$'\n'
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
