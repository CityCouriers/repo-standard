"""Wspólne pomoce testów: syntetyczne repozytorium wzorca i zaślepka sieci. Dane wyłącznie syntetyczne."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STANDARD_DIR = ROOT / ".github" / "standard"
for extra in (STANDARD_DIR, ROOT / "scripts"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

import build_manifest  # noqa: E402
import standard_sync  # noqa: E402

SHA = "a" * 40
OTHER_SHA = "b" * 40
REPO = standard_sync.STANDARD_REPO

SOURCE_FILES = {
    ".github/standard/tool.py": "print('tool')\n",
    ".github/standard/common/helper.py": "VALUE = 1\n",
    ".github/workflows/lint.yml": "name: lint\n",
    ".github/dependabot.yml": (
        "version: 2\nupdates:\n  # repo-standard:begin github-actions\n  - package-ecosystem: github-actions\n"
        "    schedule:\n      interval: weekly\n      day: saturday\n  # repo-standard:end github-actions\n"
    ),
    "seeds/config.yml": "blank_issues_enabled: false\ncontact_links: []\n",
}

MANIFEST = {
    "schema": 1,
    "version": "v1.0.0",
    "files": [
        {"path": ".github/standard/tool.py", "kind": "exact", "critical": True, "sha256": "0" * 64},
        {"path": ".github/standard/common/helper.py", "kind": "exact", "critical": True, "sha256": "0" * 64},
        {"path": ".github/workflows/lint.yml", "kind": "exact", "overridable": True, "sha256": "0" * 64},
        {"path": ".github/dependabot.yml", "kind": "block", "block": "github-actions",
         "skeleton": "version: 2\nupdates:\n", "sha256": "0" * 64},
        {"path": ".github/ISSUE_TEMPLATE/config.yml", "source": "seeds/config.yml", "kind": "seed",
         "overridable": True, "markers": ["blank_issues_enabled: false"], "sha256": "0" * 64},
        {"path": ".github/repo-standard.json", "kind": "param"},
    ],
}


def write_tree(root: Path, files: dict[str, str]) -> None:
    for path, text in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))


def put(path: Path, text: str) -> None:
    """Zapis bez tłumaczenia końców linii (testy sumują bajty)."""
    path.write_bytes(text.encode("utf-8"))


def make_source(root: Path, files: dict[str, str] | None = None) -> dict:
    """Zapisuje syntetyczne repozytorium wzorca (pliki i manifest z poprawnymi sumami); zwraca manifest."""
    write_tree(root, files or SOURCE_FILES)
    manifest = build_manifest.refreshed(json.loads(json.dumps(MANIFEST)), root)
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


def serve(root: Path, sha: str = SHA, tags: dict[str, str] | None = None):
    """Zaślepka `fetch`: pliki z `root` pod adresami raw dla `sha`, tagi wydań z `tags`; reszta to `SyncError`."""
    calls: list[str] = []

    def fetch(url: str, token: str | None) -> bytes:
        calls.append(url)
        prefix = f"https://raw.githubusercontent.com/{REPO}/{sha}/"
        if url.startswith(prefix):
            target = root / url[len(prefix):].replace("%20", " ")
            if target.is_file():
                return target.read_bytes()
        for tag, tag_sha in (tags or {}).items():
            if url == f"https://api.github.com/repos/{REPO}/git/ref/tags/{tag}":
                return json.dumps({"object": {"type": "commit", "sha": tag_sha}}).encode()
        raise standard_sync.SyncError(f"brak {url}")

    fetch.calls = calls
    return fetch


def valid_params(**changes) -> dict:
    params = {
        "schema": 1,
        "standard": {"version": "v1.0.0", "sha": SHA},
        "audit": {"active_since": "2026-01-01T00:00:00Z"},
        "triage": {"active_since": "2026-01-01T00:00:00Z"},
        "quality_gate": {"workflow": "quality.yml", "jobs": ["lint", "tests"],
                         "required": {"pull_request": ["lint", "tests"], "push": ["tests"], "workflow_dispatch": ["tests"]}},
        "review_gate": {"protected_paths": ["pyproject.toml"]},
        "overrides": [],
    }
    params.update(changes)
    return params
