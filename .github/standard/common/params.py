"""Plik parametrów repozytorium (`.github/repo-standard.json`): wczytanie i walidacja.

To jedyny plik konsumenta, którego standard nigdy nie nadpisuje. Walidacja jest ścisła:
nieznany klucz, zły typ albo zły format to błąd, a nie wartość domyślna (fail-closed).
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime

PARAMS_PATH = ".github/repo-standard.json"
SCHEMA = 1
TOP_KEYS = ("schema", "standard", "audit", "triage", "quality_gate", "review_gate", "overrides")
VERSION = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
FULL_SHA = re.compile(r"[0-9a-f]{40}")
ISO_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
ISSUE_REF = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*")
WORKFLOW_FILE = re.compile(r"[A-Za-z0-9_.-]+\.ya?ml")
EVENTS = ("pull_request", "push", "workflow_dispatch")
OVERRIDE_KEYS = ("path", "reason", "until", "issue")


class ParamsError(Exception):
    """Plik parametrów jest nieczytelny albo niezgodny ze schematem."""

    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def parse_version(value: object) -> tuple[int, int, int] | None:
    """`v1.2.3` -> (1, 2, 3); None, gdy napis nie ma postaci wersji wydania."""
    match = VERSION.fullmatch(value) if isinstance(value, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def valid_date(value: object, pattern: re.Pattern, parse) -> bool:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        return False
    try:
        parse(value)
    except ValueError:
        return False
    return True


def parse_instant(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")


def safe_relative(path: object) -> bool:
    """Ścieżka względna w repo: segmenty niepuste i bez `.`/`..` (więc bez `/` na brzegach), bez `\\` i `:`, bez znaków sterujących."""
    if not isinstance(path, str) or not path or path != path.strip():
        return False
    if "\\" in path or ":" in path:
        return False
    if any(ord(char) < 32 or ord(char) == 127 for char in path):
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def string_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item for item in value)


def object_errors(where: str, value: object, keys: tuple[str, ...]) -> list[str]:
    if not isinstance(value, dict):
        return [f"{where}: oczekiwano obiektu"]
    errors = [f"{where}: nieznany klucz {key!r}" for key in value if key not in keys]
    errors += [f"{where}: brak klucza {key!r}" for key in keys if key not in value]
    return errors


def standard_errors(value: object) -> list[str]:
    errors = object_errors("standard", value, ("version", "sha"))
    if errors:
        return errors
    if parse_version(value["version"]) is None:
        errors.append(f"standard.version: oczekiwano postaci v1.2.3, jest {value['version']!r}")
    if not isinstance(value["sha"], str) or not FULL_SHA.fullmatch(value["sha"]):
        errors.append("standard.sha: oczekiwano pełnego SHA (40 znaków hex, małe litery)")
    return errors


def activation_errors(name: str, value: object) -> list[str]:
    errors = object_errors(name, value, ("active_since",))
    if errors:
        return errors
    since = value["active_since"]
    if since != "" and not valid_date(since, ISO_UTC, parse_instant):
        return [f"{name}.active_since: oczekiwano RRRR-MM-DDTGG:MM:SSZ (UTC) albo pustego napisu, jest {since!r}"]
    return []


def quality_gate_errors(value: object) -> list[str]:
    errors = object_errors("quality_gate", value, ("workflow", "jobs", "required"))
    if errors:
        return errors
    if not isinstance(value["workflow"], str) or not WORKFLOW_FILE.fullmatch(value["workflow"]):
        errors.append("quality_gate.workflow: oczekiwano nazwy pliku .yml/.yaml")
    jobs = value["jobs"]
    if not string_list(jobs) or not jobs or len(set(jobs)) != len(jobs):
        return errors + ["quality_gate.jobs: oczekiwano niepustej listy unikalnych nazw jobów"]
    required = value["required"]
    errors += object_errors("quality_gate.required", required, EVENTS)
    if isinstance(required, dict):
        for event in EVENTS:
            names = required.get(event)
            if not string_list(names) or len(set(names)) != len(names):
                errors.append(f"quality_gate.required.{event}: oczekiwano listy unikalnych nazw jobów")
            elif any(name not in jobs for name in names):
                unknown = [name for name in names if name not in jobs]
                errors.append(f"quality_gate.required.{event}: jobów spoza `jobs`: {unknown}")
    return errors


def review_gate_errors(value: object) -> list[str]:
    errors = object_errors("review_gate", value, ("protected_paths",))
    if errors:
        return errors
    paths = value["protected_paths"]
    if not isinstance(paths, list) or not all(safe_relative(path) for path in paths):
        return ["review_gate.protected_paths: oczekiwano listy bezpiecznych ścieżek względnych"]
    return []


def override_errors(index: int, entry: object) -> list[str]:
    where = f"overrides[{index}]"
    errors = object_errors(where, entry, OVERRIDE_KEYS)
    if errors:
        return errors
    if not safe_relative(entry["path"]):
        errors.append(f"{where}.path: oczekiwano bezpiecznej ścieżki względnej")
    if not isinstance(entry["reason"], str) or not entry["reason"].strip():
        errors.append(f"{where}.reason: powód jest wymagany")
    if not valid_date(entry["until"], ISO_DATE, date.fromisoformat):
        errors.append(f"{where}.until: oczekiwano daty RRRR-MM-DD")
    if not isinstance(entry["issue"], str) or not ISSUE_REF.fullmatch(entry["issue"]):
        errors.append(f"{where}.issue: oczekiwano postaci wlasciciel/repo#nr")
    return errors


def validate(params: object) -> list[str]:
    """Lista błędów schematu; pusta, gdy plik jest poprawny."""
    if not isinstance(params, dict):
        return ["plik parametrów: oczekiwano obiektu JSON"]
    errors = [f"nieznany klucz {key!r}" for key in params if key not in TOP_KEYS]
    errors += [f"brak klucza {key!r}" for key in TOP_KEYS if key not in params]
    if "schema" in params and params["schema"] != SCHEMA:
        errors.append(f"schema: oczekiwano {SCHEMA}, jest {params['schema']!r}")
    checks = (
        ("standard", standard_errors),
        ("audit", lambda value: activation_errors("audit", value)),
        ("triage", lambda value: activation_errors("triage", value)),
        ("quality_gate", quality_gate_errors),
        ("review_gate", review_gate_errors),
    )
    for key, check in checks:
        if key in params:
            errors += check(params[key])
    overrides = params.get("overrides")
    if "overrides" in params:
        if not isinstance(overrides, list):
            errors.append("overrides: oczekiwano listy")
        else:
            for index, entry in enumerate(overrides):
                errors += override_errors(index, entry)
            paths = [entry.get("path") for entry in overrides if isinstance(entry, dict)]
            errors += [f"overrides: powtórzona ścieżka {path!r}" for path in sorted(set(paths)) if paths.count(path) > 1]
    return errors


def parse_json_object(text: str) -> object:
    """JSON z odrzuceniem powtórzonych kluczy (powtórzenie zmieniłoby wartość po cichu)."""

    def pairs(items: list[tuple[str, object]]) -> dict:
        keys = [key for key, _ in items]
        duplicates = sorted({key for key in keys if keys.count(key) > 1})
        if duplicates:
            raise ValueError(f"powtórzone klucze JSON: {duplicates}")
        return dict(items)

    return json.loads(text, object_pairs_hook=pairs)


def load(text: str) -> dict:
    """Wczytuje i waliduje plik parametrów; błąd to `ParamsError`."""
    try:
        params = parse_json_object(text)
    except ValueError as error:
        raise ParamsError([f"plik parametrów nie jest poprawnym JSON: {error}"]) from error
    errors = validate(params)
    if errors:
        raise ParamsError(errors)
    return params
