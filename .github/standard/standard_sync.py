"""Kopiowanie wzorca i kontrola rozjazdu (`check`, `apply`).

`apply` pobiera `manifest.json` i pliki z publicznego repozytorium wzorca po PEŁNYM SHA commita wydania
(bez tokenu), sprawdza sumy SHA-256 i zapisuje pliki oraz `standard.version` / `standard.sha` w pliku
parametrów. `check` porównuje pliki konsumenta z manifestem wersji z pliku parametrów:
  exact - suma SHA-256 pliku musi się zgadzać;
  block - zgodny musi być blok tekstu między znacznikami `# repo-standard:begin <id>` i `# repo-standard:end <id>`;
  seed  - plik kopiowany raz; sprawdzane są tylko wymagane znaczniki;
  param - plik lokalny walidowany schematem (`common/params.py`).
Plik z flagą `critical` jest zawsze `exact` i nie może mieć odstępstwa. Odstępstwo (`overrides`) dotyczy tylko
plików `overridable`, wygasa z terminem (najwyżej 90 dni) i wymaga zgłoszenia.

Zaufanie: `--params` wskazuje plik parametrów, z którego pochodzi przypięcie wzorca (w CI na
`pull_request_target` to plik z domyślnej gałęzi), a `--tree REV` czyta pliki konsumenta z commita
(`git cat-file`, bez checkoutu i bez wykonania). Repozytorium wzorca jest stałą kodu, nie parametrem.

Kody wyjścia: 0 zgodne, 1 rozjazd, 2 błąd działania (sieć, zły manifest, zły plik parametrów) - fail-closed.

Użycie:
    python standard_sync.py check [--root .] [--params PLIK] [--tree REV] [--verify-issues] [--self]
    python standard_sync.py apply --version v1.0.0 [--root .] [--dry-run]
    python standard_sync.py apply --sha <pełny SHA> [--root .]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import params as params_module  # noqa: E402

UTF8 = "utf-8"  # pragma: no mutate - wielkosc liter nazwy kodeka jest rownowazna
STANDARD_REPO = "CityCouriers/repo-standard"
MANIFEST_PATH = "manifest.json"
MANIFEST_SCHEMA = 1
OVERRIDE_MAX_DAYS = 90
MAX_DOWNLOAD = 5_000_000
KINDS = ("exact", "block", "seed", "param")
ENTRY_KEYS = ("path", "source", "kind", "critical", "overridable", "sha256", "block", "markers", "skeleton")
SHA256 = re.compile(r"[0-9a-f]{64}")
BLOCK_ID = re.compile(r"[a-z0-9-]+")
REPO_NAME = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
BEGIN_MARK = "# repo-standard:begin "
END_MARK = "# repo-standard:end "
SELF_ROOTS = (".github/standard/",)
SKIP_PARTS = ("__pycache__",)

Fetch = Callable[[str, str | None], bytes]


class SyncError(Exception):
    """Błąd działania (nie rozjazd): sieć, manifest, plik parametrów."""


def read_utf8(path: Path) -> str:
    """Treść pliku jako UTF-8 niezależnie od ustawień systemu."""
    return path.read_bytes().decode(UTF8)  # pragma: no mutate - UTF-8 jest domyślnym kodowaniem bytes.decode


def dump_json(value: object) -> bytes:
    """JSON z wcięciem 2, polskie znaki bez zmian, końcowy LF, UTF-8 (bez tłumaczenia końców linii)."""
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode(UTF8)  # pragma: no mutate - ensure_ascii=None jest równoważne False


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def block_of(text: str, block_id: str) -> str | None:
    """Tekst między znacznikami bloku (każdy wiersz z `\\n`); None, gdy znaczników nie ma dokładnie po jednym."""
    lines = text.split("\n")
    begin = [i for i, line in enumerate(lines) if line.strip() == BEGIN_MARK + block_id]
    end = [i for i, line in enumerate(lines) if line.strip() == END_MARK + block_id]
    if len(begin) != 1 or len(end) != 1 or begin[0] >= end[0]:  # pragma: no mutate - begin i end to rozne linie
        return None
    return "".join(line + "\n" for line in lines[begin[0] + 1:end[0]])


def replace_block(text: str, block_id: str, new_block: str) -> str | None:
    """`text` z podmienionym blokiem; None, gdy brak poprawnych znaczników."""
    if block_of(text, block_id) is None:
        return None
    lines = text.split("\n")
    begin = next(i for i, line in enumerate(lines) if line.strip() == BEGIN_MARK + block_id)
    end = next(i for i, line in enumerate(lines) if line.strip() == END_MARK + block_id)
    return "\n".join(lines[:begin + 1]) + "\n" + new_block + "\n".join(lines[end:])


def safe_manifest_path(path: object) -> bool:
    """Ścieżka względna bez segmentu `.git` (wzorzec nie zapisuje do katalogu git konsumenta)."""
    return params_module.safe_relative(path) and ".git" not in path.lower().split("/")


def entry_errors(index: int, entry: object) -> list[str]:
    where = f"files[{index}]"
    if not isinstance(entry, dict):
        return [f"{where}: oczekiwano obiektu"]
    errors = [f"{where}: nieznany klucz {key!r}" for key in entry if key not in ENTRY_KEYS]
    path, kind = entry.get("path"), entry.get("kind")
    if not safe_manifest_path(path):
        errors.append(f"{where}.path: oczekiwano bezpiecznej ścieżki względnej")
    if "source" in entry and not safe_manifest_path(entry["source"]):
        errors.append(f"{where}.source: oczekiwano bezpiecznej ścieżki względnej")
    if kind not in KINDS:
        return errors + [f"{where}.kind: oczekiwano jednego z {KINDS}"]
    for flag in ("critical", "overridable"):
        if flag in entry and not isinstance(entry[flag], bool):
            errors.append(f"{where}.{flag}: oczekiwano true/false")
    if kind == "param":
        if path != params_module.PARAMS_PATH:
            errors.append(f"{where}: plik param to {params_module.PARAMS_PATH}")
        return errors + [f"{where}: pole {key!r} nie dotyczy rodzaju param" for key in ("sha256", "block", "markers", "skeleton") if key in entry]
    if not isinstance(entry.get("sha256"), str) or not SHA256.fullmatch(entry["sha256"]):
        errors.append(f"{where}.sha256: oczekiwano 64 znaków hex")
    if kind == "block":
        if not isinstance(entry.get("block"), str) or not BLOCK_ID.fullmatch(entry["block"]):
            errors.append(f"{where}.block: oczekiwano identyfikatora [a-z0-9-]+")
        if "skeleton" in entry and not isinstance(entry["skeleton"], str):
            errors.append(f"{where}.skeleton: oczekiwano napisu")
    elif "block" in entry or "skeleton" in entry:
        errors.append(f"{where}: pola block i skeleton dotyczą tylko rodzaju block")
    if kind == "seed":
        if not params_module.string_list(entry.get("markers")) or not entry.get("markers"):
            errors.append(f"{where}.markers: oczekiwano niepustej listy napisów")
    elif "markers" in entry:
        errors.append(f"{where}.markers: dotyczy tylko rodzaju seed")
    if entry.get("critical") and (kind != "exact" or entry.get("overridable")):
        errors.append(f"{where}: plik krytyczny musi być exact i bez odstępstwa")
    return errors


def manifest_errors(manifest: object) -> list[str]:
    if not isinstance(manifest, dict):
        return ["manifest: oczekiwano obiektu"]
    errors = [f"manifest: nieznany klucz {key!r}" for key in manifest if key not in ("schema", "version", "files")]
    if manifest.get("schema") != MANIFEST_SCHEMA:
        errors.append(f"manifest.schema: oczekiwano {MANIFEST_SCHEMA}")
    if params_module.parse_version(manifest.get("version")) is None:
        errors.append("manifest.version: oczekiwano postaci v1.2.3")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        return errors + ["manifest.files: oczekiwano niepustej listy"]
    for index, entry in enumerate(files):
        errors += entry_errors(index, entry)
    paths = [entry.get("path") for entry in files if isinstance(entry, dict)]
    errors += [f"manifest: powtórzona ścieżka {path!r}" for path in sorted({p for p in paths if isinstance(p, str) and paths.count(p) > 1})]
    return errors


def parse_manifest(text: str) -> dict:
    try:
        manifest = params_module.parse_json_object(text)
    except ValueError as error:
        raise SyncError(f"manifest nie jest poprawnym JSON: {error}") from error
    errors = manifest_errors(manifest)
    if errors:
        raise SyncError("manifest niepoprawny: " + "; ".join(errors))
    return manifest


class FsSource:
    """Pliki konsumenta z dysku."""

    def __init__(self, root: Path):
        self.root = root

    def read(self, path: str) -> bytes | None:
        target = self.root / path
        if target.is_symlink() or not target.is_file():
            return None
        return target.read_bytes()


class GitSource:
    """Pliki konsumenta z commita (blob odczytany przez git, bez checkoutu i bez wykonania)."""

    def __init__(self, root: Path, rev: str):
        if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._/-]*", rev) or ".." in rev:
            raise SyncError(f"zła nazwa rewizji: {rev!r}")
        self.root, self.rev = root, rev

    def git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(self.root), *args], capture_output=True)

    def read(self, path: str) -> bytes | None:
        listed = self.git("ls-tree", self.rev, "--", path)
        if listed.returncode != 0:
            raise SyncError(f"git ls-tree {self.rev}: {lossy(listed.stderr)}")
        if not lossy(listed.stdout).startswith(("100644 blob ", "100755 blob ")):
            return None
        blob = self.git("cat-file", "blob", f"{self.rev}:{path}")
        if blob.returncode != 0:
            raise SyncError(f"git cat-file {self.rev}:{path}: {lossy(blob.stderr)}")
        return blob.stdout


def lossy(data: bytes) -> str:
    """Tekst z komunikatu narzędzia (stderr) bez wyjątku przy niepoprawnym UTF-8."""
    return data.decode(errors="replace").strip()


def text_of(data: bytes) -> str | None:
    try:
        return data.decode(UTF8)
    except UnicodeDecodeError:
        return None


def entry_finding(entry: dict, data: bytes | None) -> list[str]:
    """Rozjazd jednego pliku manifestu względem jego treści (None = brak pliku)."""
    path, kind = entry["path"], entry["kind"]
    if data is None:
        return [f"{path}: brak pliku"]
    if kind == "exact":
        return [] if sha256(data) == entry["sha256"] else [f"{path}: rozjazd, suma SHA-256 różni się od manifestu"]
    text = text_of(data)
    if text is None:
        return [f"{path}: plik nie jest poprawnym UTF-8"]
    if kind == "block":
        block = block_of(text, entry["block"])
        if block is None:
            return [f"{path}: brak znaczników bloku {entry['block']!r} (po jednym begin i end)"]
        if sha256(block.encode(UTF8)) != entry["sha256"]:
            return [f"{path}: rozjazd bloku {entry['block']!r}"]
        return []
    return [f"{path}: brak znacznika {marker!r}" for marker in entry["markers"] if marker not in text]


def override_findings(manifest: dict, overrides: list[dict], today: date) -> tuple[list[str], set[str]]:
    """Błędy odstępstw i zbiór ścieżek z ważnym odstępstwem."""
    entries = {entry["path"]: entry for entry in manifest["files"]}
    findings, active = [], set()
    for override in overrides:
        path = override["path"]
        entry = entries.get(path)
        if entry is None:
            findings.append(f"odstępstwo dla pliku spoza manifestu: {path}")
        elif entry.get("critical"):
            findings.append(f"odstępstwo dla pliku krytycznego jest niedozwolone: {path}")
        elif not entry.get("overridable"):
            findings.append(f"plik nie dopuszcza odstępstwa: {path}")
        else:
            until = date.fromisoformat(override["until"])
            if until < today:
                findings.append(f"odstępstwo wygasło {override['until']}: {path} ({override['issue']})")
            elif (until - today).days > OVERRIDE_MAX_DAYS:
                findings.append(f"odstępstwo z terminem dalszym niż {OVERRIDE_MAX_DAYS} dni: {path}")
            else:
                active.add(path)
    return findings, active


def check_consumer(manifest: dict, source: FsSource | GitSource, params: dict, today: date) -> list[str]:
    findings, active = override_findings(manifest, params["overrides"], today)
    for entry in manifest["files"]:
        if entry["path"] in active:
            continue
        if entry["kind"] == "param":
            if source.read(entry["path"]) is None:
                findings.append(f"{entry['path']}: brak pliku parametrów")
            continue
        findings += entry_finding(entry, source.read(entry["path"]))
    return findings


def check_self(manifest: dict, root: Path) -> list[str]:
    """Manifest wzorca względem własnych plików repozytorium wzorca (źródło = `source` albo `path`)."""
    source = FsSource(root)
    findings = []
    listed = set()
    for entry in manifest["files"]:
        listed.add(entry["path"])
        if entry["kind"] == "param":
            continue
        origin = entry.get("source", entry["path"])
        data = source.read(origin)
        findings += entry_finding({**entry, "path": origin}, data)
        if entry["kind"] == "seed" and data is not None and sha256(data) != entry["sha256"]:
            findings.append(f"{origin}: rozjazd, suma SHA-256 źródła szablonu różni się od manifestu")
    for prefix in SELF_ROOTS:
        base = root / prefix
        for found in sorted(base.rglob("*")):
            relative = found.relative_to(root).as_posix()
            if found.is_file() and not any(part in SKIP_PARTS for part in found.parts) and not relative.endswith(".pyc"):
                if relative not in listed:
                    findings.append(f"{relative}: plik wzorca nie jest wpisany do manifestu")
    return findings


class SameHostHttps(urllib.request.HTTPRedirectHandler):
    """Przekierowanie tylko na ten sam host i https (token nie wycieka na inny adres)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target, origin = urlsplit(newurl), urlsplit(req.full_url)
        if target.scheme != "https" or target.netloc != origin.netloc:
            raise SyncError(f"przekierowanie poza ten sam host https: {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(SameHostHttps)


def http_get(url: str, token: str | None = None) -> bytes:
    if not url.startswith("https://"):
        raise SyncError(f"tylko https: {url}")
    headers = {"User-Agent": "repo-standard-sync", "Accept": "application/vnd.github+json, */*"}  # pragma: no mutate - nazwy nagłówków HTTP nie rozróżniają wielkości liter
    if token:
        headers["Authorization"] = f"Bearer {token}"  # pragma: no mutate - nazwy nagłówków HTTP nie rozróżniają wielkości liter
    try:
        with opener().open(urllib.request.Request(url, headers=headers), timeout=30) as response:
            data = response.read(MAX_DOWNLOAD + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise SyncError(f"pobranie {url}: {error}") from error
    if len(data) > MAX_DOWNLOAD:
        raise SyncError(f"odpowiedź za duża: {url}")
    return data


def raw_url(repo: str, sha: str, path: str) -> str:
    if not REPO_NAME.fullmatch(repo) or not params_module.FULL_SHA.fullmatch(sha):
        raise SyncError("zły adres: oczekiwano repo wlasciciel/nazwa i pełnego SHA")
    return f"https://raw.githubusercontent.com/{repo}/{sha}/{quote(path)}"


def fetch_manifest(repo: str, sha: str, fetch: Fetch) -> dict:
    return parse_manifest(fetch(raw_url(repo, sha, MANIFEST_PATH), None).decode(UTF8))


def resolve_tag(repo: str, tag: str, fetch: Fetch) -> str:
    """Pełny SHA commita wskazywanego przez tag wydania (także tag opisany)."""
    if not REPO_NAME.fullmatch(repo) or params_module.parse_version(tag) is None:
        raise SyncError(f"zła nazwa repozytorium albo wersji: {repo!r} {tag!r}")
    reference = json.loads(fetch(f"https://api.github.com/repos/{repo}/git/ref/tags/{tag}", None))
    target = reference["object"]
    if target["type"] == "tag":
        target = json.loads(fetch(f"https://api.github.com/repos/{repo}/git/tags/{target['sha']}", None))["object"]
    if target["type"] != "commit" or not params_module.FULL_SHA.fullmatch(target["sha"]):
        raise SyncError(f"tag {tag} nie wskazuje commita")
    return target["sha"]


def lookup_issue(ref: str, fetch: Fetch, token: str | None) -> tuple[str, list[str]]:
    """(stan, etykiety) zgłoszenia `wlasciciel/repo#nr`; błąd pobrania to `SyncError`."""
    repo, number = ref.split("#")
    data = json.loads(fetch(f"https://api.github.com/repos/{repo}/issues/{number}", token))
    if not isinstance(data, dict):
        raise SyncError("odpowiedź API nie jest obiektem")
    labels = data.get("labels") or []
    if not isinstance(labels, list) or not all(isinstance(label, dict) for label in labels):
        raise SyncError("etykiety w odpowiedzi API mają zły kształt")
    return str(data.get("state")), [label.get("name") for label in labels]


def verify_issues(overrides: list[dict], fetch: Fetch, token: str | None, repo: str) -> list[str]:
    """Zgłoszenie odstępstwa musi należeć do repozytorium konsumenta, być otwarte i mieć `audit:ok`."""
    findings = []
    for override in overrides:
        if not override["issue"].startswith(repo + "#"):
            findings.append(f"odstępstwo {override['path']}: zgłoszenie {override['issue']} nie należy do repozytorium {repo}")
            continue
        try:
            state, labels = lookup_issue(override["issue"], fetch, token)
        except (SyncError, ValueError, KeyError, TypeError) as error:
            findings.append(f"odstępstwo {override['path']}: nie można zweryfikować zgłoszenia {override['issue']} ({error})")
            continue
        if state != "open" or "audit:ok" not in labels:
            findings.append(f"odstępstwo {override['path']}: zgłoszenie {override['issue']} musi być otwarte i mieć audit:ok")
    return findings


def report(title: str, lines: list[str], env: dict[str, str]) -> None:
    print(f"## {title}")
    for line in lines:
        print(f"- {line}")
    if env.get("GITHUB_STEP_SUMMARY"):
        try:
            with open(env["GITHUB_STEP_SUMMARY"], "ab") as handle:
                handle.write((f"## {title}\n\n" + "".join(f"- {line}\n" for line in lines) + "\n").encode(UTF8))
        except OSError as error:
            print(f"::warning::nie zapisano podsumowania: {error}", file=sys.stderr)


def read_params(path: Path) -> dict:
    try:
        text = read_utf8(path)
    except OSError as error:
        raise SyncError(f"plik parametrów {path}: {error}") from error
    try:
        return params_module.load(text)
    except params_module.ParamsError as error:
        raise SyncError(f"plik parametrów {path} niepoprawny: {error}") from error


def run_check(args: argparse.Namespace, env: dict[str, str], fetch: Fetch, today: date) -> int:
    root = Path(args.root).resolve()
    if args.self_check:
        manifest = parse_manifest(read_utf8(root / MANIFEST_PATH))
        findings = check_self(manifest, root)
        report(f"standard_sync check --self: {'rozjazd' if findings else 'zgodne'}", findings or [f"{len(manifest['files'])} plików manifestu {manifest['version']}"], env)
        return 1 if findings else 0

    if args.tree and not args.params:
        raise SyncError("--tree wymaga --params: zaufane przypięcie wzorca musi pochodzić z domyślnej gałęzi, nie z PR")
    if args.verify_issues and not env.get("GITHUB_REPOSITORY"):
        raise SyncError("--verify-issues wymaga zmiennej GITHUB_REPOSITORY")
    trusted = read_params(Path(args.params) if args.params else root / params_module.PARAMS_PATH)
    pin = trusted["standard"]
    manifest = fetch_manifest(STANDARD_REPO, pin["sha"], fetch)
    findings = []
    if manifest["version"] != pin["version"]:
        findings.append(f"manifest po SHA {pin['sha'][:12]} to {manifest['version']}, a plik parametrów mówi {pin['version']}")
    source: FsSource | GitSource = GitSource(root, args.tree) if args.tree else FsSource(root)
    if args.tree:
        raw = source.read(params_module.PARAMS_PATH)
        if raw is None:
            raise SyncError(f"brak {params_module.PARAMS_PATH} w {args.tree}")
        try:
            current = params_module.load(raw.decode(UTF8))
        except (params_module.ParamsError, UnicodeDecodeError) as error:
            raise SyncError(f"{params_module.PARAMS_PATH} w {args.tree} niepoprawny: {error}") from error
    else:
        current = trusted
    if current["standard"] != pin:
        findings.append("przypięcie wzorca (standard.version, standard.sha) różni się od zaufanego pliku parametrów: zmiana wymaga wydania i akceptacji")
    findings += check_consumer(manifest, source, current, today)
    if args.verify_issues:
        findings += verify_issues(current["overrides"], fetch, env.get("GH_TOKEN") or env.get("GITHUB_TOKEN"), env["GITHUB_REPOSITORY"])
    report(f"standard_sync check ({pin['version']}): {'rozjazd' if findings else 'zgodne'}", findings or ["pliki zgodne z manifestem"], env)
    return 1 if findings else 0


def default_params() -> dict:
    """Szkielet pliku parametrów tworzonego przez `apply`; `standard` uzupełnia wywołujący."""
    return {
        "schema": params_module.SCHEMA,
        "standard": {},
        "audit": {"active_since": ""},
        "triage": {"active_since": ""},
        "quality_gate": {"workflow": "quality.yml", "jobs": ["tests"], "required": {event: ["tests"] for event in params_module.EVENTS}},
        "review_gate": {"protected_paths": []},
        "overrides": [],
    }


def write_params(path: Path, params: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(dump_json(params))


def ensure_plain_path(root: Path, path: str) -> None:
    """Zapis tylko przez zwykłe katalogi: żaden element ścieżki nie może być dowiązaniem symbolicznym."""
    current = root
    parts = Path(path).parts
    for index, part in enumerate(parts):
        current = current / part
        if current.is_symlink():
            raise SyncError(f"{path}: ścieżka przechodzi przez dowiązanie symboliczne")
        last = index == len(parts) - 1
        if current.exists() and current.is_dir() != (not last):
            raise SyncError(f"{path}: koliduje z istniejącym {'katalogiem' if last else 'plikiem'}")


def plan_apply(manifest: dict, root: Path, repo: str, sha: str, fetch: Fetch, active: set[str]) -> tuple[list[tuple[str, bytes]], list[str]]:
    """(pliki do zapisu, uwagi); wszystko pobrane i zweryfikowane przed jakimkolwiek zapisem."""
    writes, notes = [], []
    for entry in manifest["files"]:
        path, kind = entry["path"], entry["kind"]
        if kind == "param":
            continue
        if path in active:
            notes.append(f"{path}: pominięty (ważne odstępstwo)")
            continue
        data = fetch(raw_url(repo, sha, entry.get("source", path)), None)
        target = root / path
        existing = target.read_bytes() if target.is_file() and not target.is_symlink() else None
        if kind == "block":
            text = text_of(data)
            block = block_of(text, entry["block"]) if text is not None else None
            if block is None or sha256(block.encode(UTF8)) != entry["sha256"]:
                raise SyncError(f"{path}: blok {entry['block']!r} ze źródła nie zgadza się z manifestem")
            if existing is None:
                content = (entry.get("skeleton", "") + BEGIN_MARK + entry["block"] + "\n" + block + END_MARK + entry["block"] + "\n").encode(UTF8)
            else:
                current = text_of(existing)
                merged = replace_block(current, entry["block"], block) if current is not None else None
                if merged is None:
                    raise SyncError(f"{path}: istnieje bez znaczników bloku {entry['block']!r}; dopisz znaczniki ręcznie i powtórz")
                content = merged.encode(UTF8)
            writes.append((path, content))
            continue
        if sha256(data) != entry["sha256"]:
            raise SyncError(f"{path}: pobrana treść nie zgadza się z sumą w manifeście")
        if kind == "seed" and existing is not None:
            notes.append(f"{path}: seed już istnieje, zostawiony")
            continue
        writes.append((path, data))
    return writes, notes


def run_apply(args: argparse.Namespace, env: dict[str, str], fetch: Fetch, today: date) -> int:
    root = Path(args.root).resolve()
    repo = args.repo
    if bool(args.version) == bool(args.sha):
        raise SyncError("podaj dokładnie jedno z --version i --sha")
    sha = resolve_tag(repo, args.version, fetch) if args.version else args.sha
    manifest = fetch_manifest(repo, sha, fetch)
    if args.version and manifest["version"] != args.version:
        raise SyncError(f"tag {args.version} wskazuje manifest wersji {manifest['version']}")
    params_path = root / params_module.PARAMS_PATH
    params = read_params(params_path) if params_path.is_file() else default_params()
    _, active = override_findings(manifest, params["overrides"], today)
    writes, notes = plan_apply(manifest, root, repo, sha, fetch, active)
    for path, _ in writes:
        ensure_plain_path(root, path)
    lines = [f"{path}: {'do zapisu' if args.dry_run else 'zapisany'}" for path, _ in writes] + notes
    if not args.dry_run:
        for path, content in writes:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        params["standard"] = {"version": manifest["version"], "sha": sha}
        write_params(params_path, params)
        lines.append(f"{params_module.PARAMS_PATH}: standard {manifest['version']} {sha}")
    report(f"standard_sync apply {manifest['version']}{' (dry-run)' if args.dry_run else ''}", lines, env)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Kopiowanie wzorca i kontrola rozjazdu")  # pragma: no mutate
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="porównaj pliki z manifestem wersji z pliku parametrów")  # pragma: no mutate
    check.add_argument("--root", default=".")
    check.add_argument("--params", help="zaufany plik parametrów (przypięcie wzorca); domyślnie z korzenia")  # pragma: no mutate
    check.add_argument("--tree", help="czytaj pliki konsumenta z commita zamiast z dysku")  # pragma: no mutate
    check.add_argument("--verify-issues", action="store_true", help="sprawdź zgłoszenia odstępstw (otwarte, audit:ok)")  # pragma: no mutate
    check.add_argument("--self", dest="self_check", action="store_true", help="repozytorium wzorca: manifest lokalny względem własnych plików")  # pragma: no mutate
    apply = sub.add_parser("apply", help="skopiuj wydanie wzorca")  # pragma: no mutate
    apply.add_argument("--version")
    apply.add_argument("--sha")
    apply.add_argument("--root", default=".")
    apply.add_argument("--repo", default=STANDARD_REPO)
    apply.add_argument("--dry-run", action="store_true")
    return parser


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def main(argv: list[str], env: dict[str, str], fetch: Fetch = http_get, today: date | None = None) -> int:
    args = build_parser().parse_args(argv)
    today = today or utc_today()
    try:
        return (run_check if args.command == "check" else run_apply)(args, env, fetch, today)
    except Exception as error:  # fail-closed: każdy nieoczekiwany błąd to kod 2, nigdy 0 ani niejednoznaczny traceback
        report("standard_sync: przerwano", [f"{type(error).__name__}: {error}"], env)
        return 2


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:], dict(os.environ)))
