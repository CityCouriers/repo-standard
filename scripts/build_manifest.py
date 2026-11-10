"""Przelicza sumy SHA-256 w `manifest.json` z plików repozytorium wzorca (narzędzie wydawcy, nie jest kopiowane).

Wpisy (ścieżka, rodzaj, flagi `critical` i `overridable`, znaczniki) prowadzi człowiek w `manifest.json`;
to narzędzie tylko odświeża pola `sha256` i, gdy podano `--version`, wersję wydania. Po odświeżeniu
`python .github/standard/standard_sync.py check --self` musi być zielone.

Użycie:
    python scripts/build_manifest.py [--root .] [--version v1.0.0]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".github" / "standard"))

import standard_sync  # noqa: E402


def refreshed(manifest: dict, root: Path) -> dict:
    """Kopia manifestu z sumami wyliczonymi z plików; brak pliku albo bloku to `SyncError`."""
    source = standard_sync.FsSource(root)
    files = []
    for entry in manifest["files"]:
        entry = dict(entry)
        if entry["kind"] != "param":
            origin = entry.get("source", entry["path"])
            data = source.read(origin)
            if data is None:
                raise standard_sync.SyncError(f"{origin}: brak pliku")
            if entry["kind"] == "block":
                block = standard_sync.block_of(data.decode(standard_sync.UTF8), entry["block"])
                if block is None:
                    raise standard_sync.SyncError(f"{origin}: brak znaczników bloku {entry['block']!r}")
                data = block.encode(standard_sync.UTF8)
            entry["sha256"] = standard_sync.sha256(data)
        files.append(entry)
    return {**manifest, "files": files}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Odświeża sumy w manifest.json")  # pragma: no mutate
    parser.add_argument("--root", default=".")
    parser.add_argument("--version")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    path = root / standard_sync.MANIFEST_PATH
    try:
        manifest = standard_sync.parse_manifest(standard_sync.read_utf8(path))
        if args.version:
            if standard_sync.params_module.parse_version(args.version) is None:
                raise standard_sync.SyncError(f"wersja musi mieć postać v1.2.3: {args.version!r}")
            manifest["version"] = args.version
        result = refreshed(manifest, root)
    except (standard_sync.SyncError, OSError) as error:
        print(f"build_manifest: {error}", file=sys.stderr)
        return 2
    path.write_bytes(standard_sync.dump_json(result))
    print(f"manifest.json: {len(result['files'])} plików, wersja {result['version']}")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding=standard_sync.UTF8)
    sys.exit(main(sys.argv[1:]))
