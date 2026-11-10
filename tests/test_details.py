"""Testy dokładnych komunikatów, kontraktu HTTP, parsera i narzędzia wydawcy (zabijają mutanty tekstów i argumentów)."""

import argparse
import io
import json
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

import helpers
import build_manifest
import standard_sync as sync
from common import params as params_module
from test_standard_sync import Workspace, git

ENTRY = {"path": "a/b.txt", "kind": "exact", "sha256": "0" * 64}
SEED = {"path": "s.yml", "kind": "seed", "markers": ["m"], "sha256": "0" * 64}
BLOCK = {"path": "d.yml", "kind": "block", "block": "x", "sha256": "0" * 64}
PARAM = {"path": ".github/repo-standard.json", "kind": "param"}


class EntryErrorTests(unittest.TestCase):
    def errors(self, entry, index=3):
        return sync.entry_errors(index, entry)

    def test_valid_entries(self):
        for entry in (ENTRY, SEED, BLOCK, PARAM, {**BLOCK, "skeleton": "version: 2\n"}, {**ENTRY, "critical": True},
                      {**ENTRY, "overridable": True, "source": "seeds/a.txt"}):
            with self.subTest(entry=entry):
                self.assertEqual(self.errors(entry), [])

    def test_exact_messages(self):
        cases = [
            ("x", ["files[3]: oczekiwano obiektu"]),
            ({**ENTRY, "path": "../x"}, ["files[3].path: oczekiwano bezpiecznej ścieżki względnej"]),
            ({**ENTRY, "source": "/x"}, ["files[3].source: oczekiwano bezpiecznej ścieżki względnej"]),
            ({**ENTRY, "extra": 1}, ["files[3]: nieznany klucz 'extra'"]),
            ({**ENTRY, "kind": "zip"}, ["files[3].kind: oczekiwano jednego z ('exact', 'block', 'seed', 'param')"]),
            ({**ENTRY, "critical": 1}, ["files[3].critical: oczekiwano true/false"]),
            ({**ENTRY, "overridable": "x"}, ["files[3].overridable: oczekiwano true/false"]),
            ({**ENTRY, "sha256": "zz"}, ["files[3].sha256: oczekiwano 64 znaków hex"]),
            ({k: v for k, v in ENTRY.items() if k != "sha256"}, ["files[3].sha256: oczekiwano 64 znaków hex"]),
            ({**PARAM, "path": "x.json"}, ["files[3]: plik param to .github/repo-standard.json"]),
            ({**BLOCK, "block": "Bad Id"}, ["files[3].block: oczekiwano identyfikatora [a-z0-9-]+"]),
            ({**BLOCK, "skeleton": 5}, ["files[3].skeleton: oczekiwano napisu"]),
            ({**ENTRY, "block": "x"}, ["files[3]: pola block i skeleton dotyczą tylko rodzaju block"]),
            ({**ENTRY, "skeleton": "x"}, ["files[3]: pola block i skeleton dotyczą tylko rodzaju block"]),
            ({**SEED, "markers": []}, ["files[3].markers: oczekiwano niepustej listy napisów"]),
            ({**SEED, "markers": [5]}, ["files[3].markers: oczekiwano niepustej listy napisów"]),
            ({**ENTRY, "markers": ["x"]}, ["files[3].markers: dotyczy tylko rodzaju seed"]),
            ({**ENTRY, "critical": True, "overridable": True}, ["files[3]: plik krytyczny musi być exact i bez odstępstwa"]),
            ({**BLOCK, "critical": True}, ["files[3]: plik krytyczny musi być exact i bez odstępstwa"]),
        ]
        for entry, expected in cases:
            with self.subTest(entry=entry):
                self.assertEqual(self.errors(entry), expected)

    def test_param_entry_rejects_every_content_field(self):
        for key, value in (("sha256", "0" * 64), ("block", "x"), ("markers", ["m"]), ("skeleton", "s")):
            with self.subTest(key=key):
                self.assertEqual(self.errors({**PARAM, key: value}), [f"files[3]: pole {key!r} nie dotyczy rodzaju param"])


class ManifestMessageTests(unittest.TestCase):
    def test_messages(self):
        good = {"schema": 1, "version": "v1.0.0", "files": [ENTRY]}
        self.assertEqual(sync.manifest_errors({**good, "schema": 2}), ["manifest.schema: oczekiwano 1"])
        self.assertEqual(sync.manifest_errors({**good, "version": "x"}), ["manifest.version: oczekiwano postaci v1.2.3"])
        self.assertEqual(sync.manifest_errors({**good, "extra": 1}), ["manifest: nieznany klucz 'extra'"])
        self.assertEqual(sync.manifest_errors({**good, "files": [{**ENTRY, "kind": "zip"}]}),
                         ["files[0].kind: oczekiwano jednego z ('exact', 'block', 'seed', 'param')"])
        self.assertEqual(sync.manifest_errors({**good, "files": [ENTRY, {**ENTRY, "path": "z"}, {**ENTRY, "path": "c"}, {**ENTRY, "path": "c"}, {**ENTRY, "path": "z"}]}),
                         ["manifest: powtórzona ścieżka 'c'", "manifest: powtórzona ścieżka 'z'"])

    def test_entry_index_is_reported(self):
        errors = sync.manifest_errors({"schema": 1, "version": "v1.0.0", "files": [ENTRY, {**ENTRY, "path": "b", "kind": "zip"}]})
        self.assertEqual(errors, ["files[1].kind: oczekiwano jednego z ('exact', 'block', 'seed', 'param')"])

    def test_parse_manifest_messages(self):
        with self.assertRaises(sync.SyncError) as caught:
            sync.parse_manifest("{")
        self.assertTrue(str(caught.exception).startswith("manifest nie jest poprawnym JSON: "))
        with self.assertRaises(sync.SyncError) as caught:
            sync.parse_manifest(json.dumps({"schema": 2, "version": "x", "files": [ENTRY]}))
        self.assertEqual(str(caught.exception), "manifest niepoprawny: manifest.schema: oczekiwano 1; manifest.version: oczekiwano postaci v1.2.3")


class ParamsMessageTests(unittest.TestCase):
    def test_override_errors_accumulate_with_other_errors(self):
        good = {"path": "a/b.yml", "reason": "r", "until": "2026-12-31", "issue": "o/r#1"}
        data = helpers.valid_params(schema=2, overrides=[{**good, "reason": ""}, {**good, "path": "c", "until": "x"}])
        self.assertEqual(params_module.validate(data), [
            "schema: oczekiwano 1, jest 2",
            "overrides[0].reason: powód jest wymagany",
            "overrides[1].until: oczekiwano daty RRRR-MM-DD",
        ])

    def errors(self, **changes):
        return params_module.validate(helpers.valid_params(**changes))

    def test_quality_gate_messages(self):
        base = helpers.valid_params()["quality_gate"]
        req = base["required"]
        self.assertEqual(self.errors(quality_gate={**base, "workflow": "a/b.yml"}), ["quality_gate.workflow: oczekiwano nazwy pliku .yml/.yaml"])
        self.assertEqual(self.errors(quality_gate={**base, "workflow": 5}), ["quality_gate.workflow: oczekiwano nazwy pliku .yml/.yaml"])
        for jobs in ([], ["a", "a"], ["a", 1], "x"):
            with self.subTest(jobs=jobs):
                self.assertEqual(self.errors(quality_gate={**base, "jobs": jobs}), ["quality_gate.jobs: oczekiwano niepustej listy unikalnych nazw jobów"])
        self.assertEqual(self.errors(quality_gate={**base, "extra": 1}), ["quality_gate: nieznany klucz 'extra'"])
        self.assertEqual(self.errors(quality_gate={**base, "required": []}), ["quality_gate.required: oczekiwano obiektu"])
        self.assertEqual(self.errors(quality_gate={**base, "required": {**req, "x": []}}), ["quality_gate.required: nieznany klucz 'x'"])
        self.assertEqual(self.errors(quality_gate={**base, "required": {k: v for k, v in req.items() if k != "push"}}),
                         ["quality_gate.required: brak klucza 'push'", "quality_gate.required.push: oczekiwano listy unikalnych nazw jobów"])
        self.assertEqual(self.errors(quality_gate={**base, "required": {**req, "push": ["tests", "tests"]}}),
                         ["quality_gate.required.push: oczekiwano listy unikalnych nazw jobów"])
        self.assertEqual(self.errors(quality_gate={**base, "required": {**req, "push": "tests"}}),
                         ["quality_gate.required.push: oczekiwano listy unikalnych nazw jobów"])
        self.assertEqual(self.errors(quality_gate={**base, "required": {**req, "workflow_dispatch": [1]}}),
                         ["quality_gate.required.workflow_dispatch: oczekiwano listy unikalnych nazw jobów"])

    def test_object_errors_use_the_given_name(self):
        self.assertEqual(self.errors(quality_gate={"workflow": "q.yml", "jobs": ["a"]}), ["quality_gate: brak klucza 'required'"])
        self.assertEqual(self.errors(quality_gate=[]), ["quality_gate: oczekiwano obiektu"])

    def test_standard_sha_message(self):
        self.assertEqual(self.errors(standard={"version": "v1.0.0", "sha": "abc"}), ["standard.sha: oczekiwano pełnego SHA (40 znaków hex, małe litery)"])

    def test_review_gate_message(self):
        self.assertEqual(self.errors(review_gate={"protected_paths": ["../x"]}),
                         ["review_gate.protected_paths: oczekiwano listy bezpiecznych ścieżek względnych"])

    def test_override_messages_and_indexes(self):
        good = {"path": "a/b.yml", "reason": "r", "until": "2026-12-31", "issue": "o/r#1"}
        self.assertEqual(self.errors(overrides=[good, {**good, "path": "../x"}]), ["overrides[1].path: oczekiwano bezpiecznej ścieżki względnej"])
        self.assertEqual(self.errors(overrides=[{**good, "reason": " "}]), ["overrides[0].reason: powód jest wymagany"])
        self.assertEqual(self.errors(overrides=[{**good, "reason": 5}]), ["overrides[0].reason: powód jest wymagany"])
        self.assertEqual(self.errors(overrides=[{**good, "until": "2026-13-01"}]), ["overrides[0].until: oczekiwano daty RRRR-MM-DD"])
        self.assertEqual(self.errors(overrides=[{**good, "issue": "x"}]), ["overrides[0].issue: oczekiwano postaci wlasciciel/repo#nr"])
        self.assertEqual(self.errors(overrides=[good, good, {**good, "path": "c/d.yml"}]), ["overrides: powtórzona ścieżka 'a/b.yml'"])
        self.assertEqual(self.errors(overrides=[{**good, "path": "b"}, {**good, "path": "a"}, {**good, "path": "a"}, {**good, "path": "b"}]),
                         ["overrides: powtórzona ścieżka 'a'", "overrides: powtórzona ścieżka 'b'"])

    def test_params_error_joins_messages_with_semicolon(self):
        self.assertEqual(str(params_module.ParamsError(["a", "b"])), "a; b")

    def test_safe_relative_cases(self):
        for path in ("a", "a/b", "a b/c.yml", ".github/x.yml", "a.b/c"):
            with self.subTest(path=path):
                self.assertTrue(params_module.safe_relative(path), path)
        for path in ("", " ", "/a", "a/", "a//b", "./a", "a/./b", "../a", "a/../b", "a\\b", "c:x", "a/b:c", "a\x1fb", "a\x7fb", "a\tb", "a ", " a", 5, None):
            with self.subTest(path=path):
                self.assertFalse(params_module.safe_relative(path), repr(path))

    def test_string_list(self):
        self.assertTrue(params_module.string_list(["a", "b"]))
        self.assertTrue(params_module.string_list([]))
        for value in ([5], ["a", 5], [""], "a", None, ["a", None]):
            with self.subTest(value=value):
                self.assertFalse(params_module.string_list(value))


def patch_open(**kwargs):
    """Podmienia `opener()`; zwraca (patch, mock metody open)."""
    fake = mock.MagicMock()
    fake.open = mock.MagicMock(**kwargs)
    return mock.patch.object(sync, "opener", return_value=fake), fake.open


class HttpTests(unittest.TestCase):
    def fake_response(self, data):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = data
        return response

    def get(self, response=None, token="unset", url="https://example.invalid/x", **kwargs):
        patch, opened = patch_open(return_value=response, **kwargs)
        with patch:
            result = sync.http_get(url) if token == "unset" else sync.http_get(url, token)
        return result, opened

    def test_request_headers_timeout_and_limit(self):
        response = self.fake_response(b"data")
        result, opened = self.get(response, None)
        self.assertEqual(result, b"data")
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.invalid/x")
        self.assertEqual(request.get_header("User-agent"), "repo-standard-sync")
        self.assertEqual(request.get_header("Accept"), "application/vnd.github+json, */*")
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(opened.call_args.kwargs, {"timeout": 30})
        response.read.assert_called_once_with(sync.MAX_DOWNLOAD + 1)

    def test_token_is_sent_as_bearer(self):
        _, opened = self.get(self.fake_response(b""), "synthetic")
        self.assertEqual(opened.call_args.args[0].get_header("Authorization"), "Bearer synthetic")

    def test_empty_token_is_not_sent(self):
        _, opened = self.get(self.fake_response(b""), "")
        self.assertIsNone(opened.call_args.args[0].get_header("Authorization"))

    def test_limit_boundary(self):
        result, _ = self.get(self.fake_response(b"x" * sync.MAX_DOWNLOAD), None)
        self.assertEqual(len(result), sync.MAX_DOWNLOAD)
        with self.assertRaises(sync.SyncError) as caught:
            self.get(self.fake_response(b"x" * (sync.MAX_DOWNLOAD + 1)), None)
        self.assertEqual(str(caught.exception), "odpowiedź za duża: https://example.invalid/x")

    def test_network_errors_are_wrapped(self):
        for error in (urllib.error.URLError("brak sieci"), TimeoutError("czas"), OSError("io")):
            with self.subTest(error=error):
                with self.assertRaises(sync.SyncError) as caught:
                    self.get(None, None, side_effect=error)
                self.assertTrue(str(caught.exception).startswith("pobranie https://example.invalid/x: "))

    def test_non_https_message(self):
        with self.assertRaises(sync.SyncError) as caught:
            sync.http_get("http://example.invalid/x", None)
        self.assertEqual(str(caught.exception), "tylko https: http://example.invalid/x")

    def test_default_token_argument(self):
        result, _ = self.get(self.fake_response(b"ok"))
        self.assertEqual(result, b"ok")

    def test_opener_uses_same_host_redirect_handler(self):
        handlers = [type(handler) for handler in sync.opener().handlers]
        self.assertIn(sync.SameHostHttps, handlers)
        self.assertNotIn(urllib.request.HTTPRedirectHandler, handlers)


class RedirectTests(unittest.TestCase):
    def redirect(self, new_url):
        request = urllib.request.Request("https://api.example.invalid/a", headers={"Authorization": "Bearer t"})
        return sync.SameHostHttps().redirect_request(request, None, 302, "Found", {}, new_url)

    def test_same_host_https_is_followed(self):
        followed = self.redirect("https://api.example.invalid/b")
        self.assertEqual(followed.full_url, "https://api.example.invalid/b")

    def test_other_host_or_http_is_refused(self):
        for target in ("https://evil.example.invalid/b", "http://api.example.invalid/b", "file:///etc/passwd", "ftp://api.example.invalid/b"):
            with self.subTest(target=target):
                with self.assertRaises(sync.SyncError) as caught:
                    self.redirect(target)
                self.assertEqual(str(caught.exception), f"przekierowanie poza ten sam host https: {target}")


class UrlMessageTests(unittest.TestCase):
    def test_messages(self):
        with self.assertRaises(sync.SyncError) as caught:
            sync.raw_url("bad", helpers.SHA, "x")
        self.assertEqual(str(caught.exception), "zły adres: oczekiwano repo wlasciciel/nazwa i pełnego SHA")
        with self.assertRaises(sync.SyncError) as caught:
            sync.resolve_tag("bad", "v1.0.0", lambda url, token: b"")
        self.assertEqual(str(caught.exception), "zła nazwa repozytorium albo wersji: 'bad' 'v1.0.0'")
        with self.assertRaises(sync.SyncError) as caught:
            sync.resolve_tag(helpers.REPO, "v1.0.0", lambda url, token: json.dumps({"object": {"type": "tree", "sha": helpers.SHA}}).encode())
        self.assertEqual(str(caught.exception), "tag v1.0.0 nie wskazuje commita")

    def test_fetch_is_called_with_explicit_none_token(self):
        seen = []

        def fetch(url, token):
            seen.append((url, token))
            return json.dumps({"object": {"type": "tag", "sha": helpers.OTHER_SHA}} if "ref/tags" in url else {"object": {"type": "commit", "sha": helpers.SHA}}).encode()

        sync.resolve_tag(helpers.REPO, "v1.0.0", fetch)
        self.assertEqual([token for _, token in seen], [None, None])
        seen.clear()
        manifest = json.dumps({"schema": 1, "version": "v1.0.0", "files": [ENTRY]}).encode()
        sync.fetch_manifest(helpers.REPO, helpers.SHA, lambda url, token: seen.append((url, token)) or manifest)
        self.assertEqual(seen, [(f"https://raw.githubusercontent.com/{helpers.REPO}/{helpers.SHA}/manifest.json", None)])

    def test_manifest_must_be_utf8(self):
        with self.assertRaises(UnicodeDecodeError):
            sync.fetch_manifest(helpers.REPO, helpers.SHA, lambda url, token: b"\xff")

    def test_lookup_issue_splits_reference(self):
        seen = []

        def fetch(url, token):
            seen.append((url, token))
            return b'{"state": "open", "labels": [{"name": "a"}, {"name": "b"}]}'

        self.assertEqual(sync.lookup_issue("org/repo#12", fetch, "tok"), ("open", ["a", "b"]))
        self.assertEqual(seen, [("https://api.github.com/repos/org/repo/issues/12", "tok")])


class ParserTests(unittest.TestCase):
    def test_check_defaults_and_flags(self):
        args = sync.build_parser().parse_args(["check"])
        self.assertEqual((args.command, args.root, args.params, args.tree, args.verify_issues, args.self_check), ("check", ".", None, None, False, False))
        args = sync.build_parser().parse_args(["check", "--root", "r", "--params", "p", "--tree", "t", "--verify-issues", "--self"])
        self.assertEqual((args.root, args.params, args.tree, args.verify_issues, args.self_check), ("r", "p", "t", True, True))

    def test_apply_defaults_and_flags(self):
        args = sync.build_parser().parse_args(["apply"])
        self.assertEqual((args.command, args.version, args.sha, args.root, args.repo, args.dry_run), ("apply", None, None, ".", sync.STANDARD_REPO, False))
        args = sync.build_parser().parse_args(["apply", "--version", "v1.0.0", "--sha", "s", "--root", "r", "--repo", "o/n", "--dry-run"])
        self.assertEqual((args.version, args.sha, args.root, args.repo, args.dry_run), ("v1.0.0", "s", "r", "o/n", True))

    def test_command_is_required(self):
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            sync.build_parser().parse_args([])


class ClockTests(unittest.TestCase):
    def test_utc_today_uses_utc(self):
        calls = []

        class Clock:
            @staticmethod
            def now(tz=None):
                calls.append(tz)
                return datetime(2026, 6, 1, 12, tzinfo=timezone.utc)

        with mock.patch.object(sync, "datetime", Clock):
            self.assertEqual(sync.utc_today(), date(2026, 6, 1))
        self.assertEqual(calls, [timezone.utc])

    def test_main_uses_utc_today_by_default(self):
        with mock.patch.object(sync, "utc_today", return_value=date(2030, 1, 1)) as clock, tempfile.TemporaryDirectory() as tmp:
            with redirect_stdout(io.StringIO()):
                sync.main(["check", "--root", tmp], {})
        clock.assert_called_once_with()


class ReportOutputTests(Workspace):
    def test_apply_dry_run_output_is_exact(self):
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst), "--dry-run")
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], "## standard_sync apply v1.0.0 (dry-run)")
        self.assertIn("- .github/standard/tool.py: do zapisu", lines)
        self.assertNotIn("zapisany", out)

    def test_apply_output_is_exact(self):
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        lines = out.splitlines()
        self.assertEqual(lines[0], "## standard_sync apply v1.0.0")
        self.assertIn("- .github/standard/tool.py: zapisany", lines)
        self.assertEqual(lines[-1], f"- .github/repo-standard.json: standard v1.0.0 {helpers.SHA}")
        self.assertNotIn("do zapisu", out)

    def test_check_titles(self):
        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        code, out = self.check()
        self.assertEqual(out.splitlines()[0], "## standard_sync check (v1.0.0): zgodne")
        helpers.put(self.dst / ".github/standard/tool.py", "x\n")
        code, out = self.check()
        self.assertEqual(out.splitlines()[0], "## standard_sync check (v1.0.0): rozjazd")
        code, out = self.run_main("check", "--self", "--root", str(self.src))
        self.assertEqual(out.splitlines()[0], "## standard_sync check --self: zgodne")
        helpers.put(self.src / ".github/standard/tool.py", "x\n")
        code, out = self.run_main("check", "--self", "--root", str(self.src))
        self.assertEqual(out.splitlines()[0], "## standard_sync check --self: rozjazd")

    def test_step_summary_is_utf8_with_exact_layout(self):
        summary = self.dst / "summary.md"
        self.env = {"GITHUB_STEP_SUMMARY": str(summary)}
        sync.report("Tytuł ąę", ["jeden", "dwa żółć"], self.env)
        sync.report("Drugi", ["x"], self.env)
        self.assertEqual(summary.read_bytes(), "## Tytuł ąę\n\n- jeden\n- dwa żółć\n\n## Drugi\n\n- x\n\n".encode("utf-8"))

    def test_report_without_summary_env_writes_nothing_extra(self):
        out = io.StringIO()
        with redirect_stdout(out):
            sync.report("T", ["a", "b"], {})
        self.assertEqual(out.getvalue(), "## T\n- a\n- b\n")

    def test_error_report_names_exception_type(self):
        code, out = self.run_main("apply", "--version", "v9.9.9", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertEqual(out.splitlines()[0], "## standard_sync: przerwano")
        self.assertTrue(out.splitlines()[1].startswith("- SyncError: "))

    def test_apply_requires_selector_message(self):
        code, out = self.run_main("apply", "--root", str(self.dst))
        self.assertEqual(out.splitlines()[1], "- SyncError: podaj dokładnie jedno z --version i --sha")

    def test_params_file_written_exactly(self):
        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        expected = sync.default_params()
        expected["standard"] = {"version": "v1.0.0", "sha": helpers.SHA}
        raw = (self.dst / ".github/repo-standard.json").read_bytes()
        self.assertEqual(raw, (json.dumps(expected, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
        self.assertIn(b'\n  "schema": 1,\n  "standard": {\n    "version"', raw)
        self.assertNotIn(b"\r", raw)

    def test_params_write_keeps_non_ascii_and_creates_parents(self):
        path = self.dst / "deep" / "dir" / "p.json"
        sync.write_params(path, {"a": "żółć"})
        self.assertEqual(path.read_bytes(), '{\n  "a": "żółć"\n}\n'.encode("utf-8"))

    def test_params_written_when_no_other_file_creates_directory(self):
        files = {"x.txt": "x\n"}
        src = self.src.parent / "src2"
        src.mkdir()
        helpers.write_tree(src, files)
        manifest = {"schema": 1, "version": "v1.0.0", "files": [{"path": "x.txt", "kind": "exact", "sha256": sync.sha256(b"x\n")}, PARAM]}
        helpers.put(src / "manifest.json", json.dumps(manifest))
        code, out = self.run_main("apply", "--sha", helpers.SHA, "--root", str(self.dst), fetch=helpers.serve(src))
        self.assertEqual(code, 0, out)
        self.assertTrue((self.dst / ".github/repo-standard.json").is_file())


class LogicEdgeTests(Workspace):
    """Pętle, które nie mogą urywać się na pierwszym pominiętym wpisie."""

    def manifest_with(self, *entries):
        return {"schema": 1, "version": "v1.0.0", "files": list(entries)}

    def test_param_entry_does_not_stop_the_scan(self):
        helpers.write_tree(self.dst, {"a.txt": "changed\n", ".github/repo-standard.json": "{}"})
        manifest = self.manifest_with(PARAM, {"path": "a.txt", "kind": "exact", "sha256": sync.sha256(b"orig\n")})
        findings = sync.check_consumer(manifest, sync.FsSource(self.dst), helpers.valid_params(), date(2026, 6, 1))
        self.assertEqual(findings, ["a.txt: rozjazd, suma SHA-256 różni się od manifestu"])

    def test_missing_params_file_names_the_file(self):
        manifest = self.manifest_with(PARAM)
        findings = sync.check_consumer(manifest, sync.FsSource(self.dst), helpers.valid_params(), date(2026, 6, 1))
        self.assertEqual(findings, [".github/repo-standard.json: brak pliku parametrów"])

    def test_override_skip_does_not_stop_the_scan(self):
        helpers.write_tree(self.dst, {"a.txt": "changed\n", "b.txt": "changed\n"})
        manifest = self.manifest_with({"path": "a.txt", "kind": "exact", "overridable": True, "sha256": sync.sha256(b"orig\n")},
                                      {"path": "b.txt", "kind": "exact", "sha256": sync.sha256(b"orig\n")})
        override = {"path": "a.txt", "reason": "r", "until": "2026-07-01", "issue": "o/r#1"}
        params = helpers.valid_params(overrides=[override])
        findings = sync.check_consumer(manifest, sync.FsSource(self.dst), params, date(2026, 6, 1))
        self.assertEqual(findings, ["b.txt: rozjazd, suma SHA-256 różni się od manifestu"])

    def test_self_check_param_entry_does_not_stop_the_scan(self):
        helpers.write_tree(self.dst, {"a.txt": "changed\n"})
        manifest = self.manifest_with(PARAM, {"path": "a.txt", "kind": "exact", "sha256": sync.sha256(b"orig\n")})
        self.assertEqual(sync.check_self(manifest, self.dst), ["a.txt: rozjazd, suma SHA-256 różni się od manifestu"])

    def test_verify_issues_checks_every_override_and_states_the_rule(self):
        overrides = [{"path": "a", "reason": "r", "until": "2026-07-01", "issue": "o/r#1"},
                     {"path": "b", "reason": "r", "until": "2026-07-01", "issue": "o/r#2"}]

        def fetch(url, token):
            if url.endswith("/1"):
                raise sync.SyncError("403")
            return b'{"state": "open", "labels": []}'

        findings = sync.verify_issues(overrides, fetch, None, "o/r")
        self.assertEqual(findings, ["odstępstwo a: nie można zweryfikować zgłoszenia o/r#1 (403)",
                                    "odstępstwo b: zgłoszenie o/r#2 musi być otwarte i mieć audit:ok"])

    def test_plan_apply_continues_after_param_and_override_entries(self):
        manifest = self.manifest_with(PARAM, {**ENTRY, "path": "skipped.txt", "overridable": True},
                                      {"path": "later.txt", "kind": "exact", "sha256": sync.sha256(b"x\n")})
        helpers.write_tree(self.src, {"later.txt": "x\n"})
        writes, notes = sync.plan_apply(manifest, self.dst, helpers.REPO, helpers.SHA, helpers.serve(self.src), {"skipped.txt"})
        self.assertEqual(writes, [("later.txt", b"x\n")])
        self.assertEqual(notes, ["skipped.txt: pominięty (ważne odstępstwo)"])

    def test_plan_apply_keeps_existing_seed_and_continues(self):
        helpers.write_tree(self.src, {"seed.txt": "m\n", "later.txt": "x\n"})
        helpers.write_tree(self.dst, {"seed.txt": "local\n"})
        manifest = self.manifest_with({"path": "seed.txt", "kind": "seed", "markers": ["m"], "sha256": sync.sha256(b"m\n")},
                                      {"path": "later.txt", "kind": "exact", "sha256": sync.sha256(b"x\n")})
        writes, notes = sync.plan_apply(manifest, self.dst, helpers.REPO, helpers.SHA, helpers.serve(self.src), set())
        self.assertEqual(writes, [("later.txt", b"x\n")])
        self.assertEqual(notes, ["seed.txt: seed już istnieje, zostawiony"])

    def test_plan_apply_block_without_skeleton_and_with_existing_file(self):
        block_text = "# repo-standard:begin x\nB\n# repo-standard:end x\n"
        helpers.write_tree(self.src, {"d.yml": block_text})
        entry = {"path": "d.yml", "kind": "block", "block": "x", "sha256": sync.sha256(b"B\n")}
        manifest = self.manifest_with(entry)
        writes, _ = sync.plan_apply(manifest, self.dst, helpers.REPO, helpers.SHA, helpers.serve(self.src), set())
        self.assertEqual(writes, [("d.yml", block_text.encode())])
        helpers.write_tree(self.dst, {"d.yml": "top\n# repo-standard:begin x\nold\n# repo-standard:end x\nbottom\n"})
        writes, _ = sync.plan_apply(manifest, self.dst, helpers.REPO, helpers.SHA, helpers.serve(self.src), set())
        self.assertEqual(writes, [("d.yml", b"top\n# repo-standard:begin x\nB\n# repo-standard:end x\nbottom\n")])

    def test_plan_apply_existing_non_utf8_block_file_is_refused(self):
        helpers.write_tree(self.src, {"d.yml": "# repo-standard:begin x\nB\n# repo-standard:end x\n"})
        (self.dst / "d.yml").write_bytes(b"\xff\xfe")
        manifest = self.manifest_with({"path": "d.yml", "kind": "block", "block": "x", "sha256": sync.sha256(b"B\n")})
        with self.assertRaises(sync.SyncError) as caught:
            sync.plan_apply(manifest, self.dst, helpers.REPO, helpers.SHA, helpers.serve(self.src), set())
        self.assertEqual(str(caught.exception), "d.yml: istnieje bez znaczników bloku 'x'; dopisz znaczniki ręcznie i powtórz")

    def test_plan_apply_error_messages_name_the_file(self):
        helpers.write_tree(self.src, {"a.txt": "other\n"})
        manifest = self.manifest_with({"path": "a.txt", "kind": "exact", "sha256": sync.sha256(b"x\n")})
        with self.assertRaises(sync.SyncError) as caught:
            sync.plan_apply(manifest, self.dst, helpers.REPO, helpers.SHA, helpers.serve(self.src), set())
        self.assertEqual(str(caught.exception), "a.txt: pobrana treść nie zgadza się z sumą w manifeście")

    def test_apply_fetches_manifest_after_resolving_and_passes_none_token(self):
        seen = []
        inner = self.fetch

        def spy(url, token):
            seen.append(token)
            return inner(url, token)

        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst), fetch=spy)
        self.assertTrue(seen)
        self.assertEqual(set(seen), {None})

    def test_check_manifest_mismatch_message_and_issue_findings_accumulate(self):
        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.set_params(standard={"version": "v1.0.1", "sha": helpers.SHA},
                        overrides=[self.override(".github/workflows/lint.yml")])
        self.env = {"GITHUB_REPOSITORY": "org/repo"}

        def fetch(url, token):
            if "api.github.com" in url:
                raise sync.SyncError("403")
            return self.fetch(url, token)

        code, out = self.run_main("check", "--root", str(self.dst), "--verify-issues", fetch=fetch)
        self.assertEqual(code, 1)
        lines = out.splitlines()
        self.assertEqual(lines[1], f"- manifest po SHA {helpers.SHA[:12]} to v1.0.0, a plik parametrów mówi v1.0.1")
        self.assertEqual(len(lines), 3)
        self.assertIn("nie można zweryfikować zgłoszenia", lines[2])

    def test_verify_issues_requires_repository_variable(self):
        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        code, out = self.check("--verify-issues")
        self.assertEqual(code, 2)
        self.assertIn("SyncError: --verify-issues wymaga zmiennej GITHUB_REPOSITORY", out)

    def test_verify_issues_rejects_foreign_repository(self):
        overrides = [{"path": "a", "reason": "r", "until": "2026-07-01", "issue": "attacker/fork#1"}]
        calls = []
        findings = sync.verify_issues(overrides, lambda url, token: calls.append(url) or b"{}", None, "org/repo")
        self.assertEqual(findings, ["odstępstwo a: zgłoszenie attacker/fork#1 nie należy do repozytorium org/repo"])
        self.assertEqual(calls, [])

    def test_verify_issues_repo_prefix_must_match_whole_name(self):
        overrides = [{"path": "a", "reason": "r", "until": "2026-07-01", "issue": "org/repo2#1"}]
        findings = sync.verify_issues(overrides, lambda url, token: b"{}", None, "org/repo")
        self.assertEqual(findings, ["odstępstwo a: zgłoszenie org/repo2#1 nie należy do repozytorium org/repo"])

    def test_lookup_issue_rejects_odd_shapes(self):
        for payload in (b"[]", b"null", b'"x"', b'{"labels": ["audit:ok"]}', b'{"labels": "x"}'):
            with self.subTest(payload=payload):
                with self.assertRaises(sync.SyncError):
                    sync.lookup_issue("o/r#1", lambda url, token, payload=payload: payload, None)

    def test_lookup_issue_error_messages(self):
        with self.assertRaises(sync.SyncError) as caught:
            sync.lookup_issue("o/r#1", lambda url, token: b"[]", None)
        self.assertEqual(str(caught.exception), "odpowiedź API nie jest obiektem")
        with self.assertRaises(sync.SyncError) as caught:
            sync.lookup_issue("o/r#1", lambda url, token: b'{"labels": ["x"]}', None)
        self.assertEqual(str(caught.exception), "etykiety w odpowiedzi API mają zły kształt")
        self.assertEqual(sync.lookup_issue("o/r#1", lambda url, token: b'{"state": "open"}', None), ("open", []))

    def test_main_turns_any_exception_into_exit_two(self):
        with mock.patch.object(sync, "run_check", side_effect=RuntimeError("x")):
            code, out = self.run_main("check", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertEqual(out.splitlines()[:2], ["## standard_sync: przerwano", "- RuntimeError: x"])

    def test_unwritable_summary_does_not_break_the_report(self):
        self.env = {"GITHUB_STEP_SUMMARY": str(self.dst / "no" / "such" / "dir" / "s.md")}
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            sync.report("T", ["a"], self.env)
        self.assertTrue(err.getvalue().startswith("::warning::nie zapisano podsumowania: "))

    def test_summary_failure_inside_error_handler_still_returns_two(self):
        self.env = {"GITHUB_STEP_SUMMARY": str(self.dst / "no" / "dir" / "s.md")}
        with redirect_stderr(io.StringIO()):
            code, _ = self.run_main("apply", "--root", str(self.dst))
        self.assertEqual(code, 2)

    def test_apply_refuses_file_in_place_of_directory_and_writes_nothing(self):
        (self.dst / ".github").mkdir()
        helpers.put(self.dst / ".github" / "standard", "i am a file\n")
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn(".github/standard/tool.py: koliduje z istniejącym plikiem", out)
        self.assertFalse((self.dst / ".github/workflows").exists())

    def test_apply_refuses_directory_in_place_of_file(self):
        (self.dst / ".github/workflows/lint.yml").mkdir(parents=True)
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn(".github/workflows/lint.yml: koliduje z istniejącym katalogiem", out)
        self.assertFalse((self.dst / ".github/standard").exists())

    def test_self_check_compares_seed_source_sum(self):
        helpers.put(self.src / "seeds/config.yml", "blank_issues_enabled: false\nother: 1\n")
        code, out = self.run_main("check", "--self", "--root", str(self.src))
        self.assertEqual(code, 1)
        self.assertEqual(out.splitlines()[1], "- seeds/config.yml: rozjazd, suma SHA-256 źródła szablonu różni się od manifestu")


    def test_check_self_message_counts_files(self):
        code, out = self.run_main("check", "--self", "--root", str(self.src))
        self.assertEqual(out.splitlines()[1], "- 6 plików manifestu v1.0.0")

    def test_check_self_manifest_is_read_as_utf8(self):
        manifest = json.loads((self.src / "manifest.json").read_text(encoding="utf-8"))
        manifest["files"][0]["note"] = "x"
        manifest["files"] = manifest["files"][:1]
        helpers.put(self.src / "manifest.json", json.dumps(manifest, ensure_ascii=False))
        code, out = self.run_main("check", "--self", "--root", str(self.src))
        self.assertEqual(code, 2)

    def test_read_params_messages(self):
        with self.assertRaises(sync.SyncError) as caught:
            sync.read_params(self.dst / "missing.json")
        self.assertTrue(str(caught.exception).startswith(f"plik parametrów {self.dst / 'missing.json'}: "))
        helpers.put(self.dst / "bad.json", "{}")
        with self.assertRaises(sync.SyncError) as caught:
            sync.read_params(self.dst / "bad.json")
        self.assertTrue(str(caught.exception).startswith(f"plik parametrów {self.dst / 'bad.json'} niepoprawny: "))

    def test_read_params_is_utf8(self):
        params = helpers.valid_params(review_gate={"protected_paths": ["ścieżka/ż.txt"]})
        helpers.put(self.dst / "p.json", json.dumps(params, ensure_ascii=False))
        self.assertEqual(sync.read_params(self.dst / "p.json")["review_gate"]["protected_paths"], ["ścieżka/ż.txt"])

    def test_non_utf8_tree_params_message(self):
        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        git(self.dst, "init", "-q", "-b", "main")
        git(self.dst, "add", "-A")
        git(self.dst, "commit", "-q", "-m", "x")
        trusted = self.dst / "trusted.json"
        trusted.write_bytes((self.dst / ".github/repo-standard.json").read_bytes())
        code, out = self.check("--tree", "HEAD", "--params", str(trusted))
        self.assertEqual(code, 0, out)


class GitSourceEdgeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        git(self.root, "init", "-q", "-b", "main")
        helpers.write_tree(self.root, {"-n": "dash\n", "a b.txt": "space\n", "run.sh": "#!/bin/sh\n", "dir/x": "x\n"})
        git(self.root, "add", "-A")
        git(self.root, "update-index", "--chmod=+x", "run.sh")
        git(self.root, "commit", "-q", "-m", "x")

    def test_option_like_name_is_a_path(self):
        self.assertEqual(sync.GitSource(self.root, "HEAD").read("-n"), b"dash\n")

    def test_name_with_space(self):
        self.assertEqual(sync.GitSource(self.root, "HEAD").read("a b.txt"), b"space\n")

    def test_executable_file_is_regular(self):
        self.assertEqual(sync.GitSource(self.root, "HEAD").read("run.sh"), b"#!/bin/sh\n")

    def test_directory_and_missing_are_none(self):
        source = sync.GitSource(self.root, "HEAD")
        self.assertIsNone(source.read("dir"))
        self.assertIsNone(source.read("nothing"))

    def test_symlink_entry_is_none(self):
        blob = git(self.root, "hash-object", "-w", "--stdin") if False else None
        done = subprocess.run(["git", "-C", str(self.root), "hash-object", "-w", "--stdin"], input=b"target", capture_output=True, check=True)
        sha = done.stdout.decode().strip()
        git(self.root, "update-index", "--add", "--cacheinfo", f"120000,{sha},link")
        git(self.root, "-c", "user.name=t", "commit", "-q", "-m", "link")
        self.assertIsNone(sync.GitSource(self.root, "HEAD").read("link"))

    def test_error_messages_carry_git_stderr_and_rev(self):
        source = sync.GitSource(self.root, "nonexistent-rev")
        with self.assertRaises(sync.SyncError) as caught:
            source.read("x")
        self.assertTrue(str(caught.exception).startswith("git ls-tree nonexistent-rev: "))
        self.assertGreater(len(str(caught.exception)), len("git ls-tree nonexistent-rev: "))

    def test_blob_error_message(self):
        source = sync.GitSource(self.root, "HEAD")
        original = source.git

        def broken(*args):
            if args[0] == "cat-file":
                return subprocess.CompletedProcess(args, 1, b"", b"b\xffoom ")
            return original(*args)

        source.git = broken
        with self.assertRaises(sync.SyncError) as caught:
            source.read("dir/x")
        self.assertEqual(str(caught.exception), "git cat-file HEAD:dir/x: b�oom")

    def test_ls_tree_error_decodes_lossy(self):
        source = sync.GitSource(self.root, "HEAD")
        source.git = lambda *args: subprocess.CompletedProcess(args, 1, b"", b"\xff bad ")
        with self.assertRaises(sync.SyncError) as caught:
            source.read("x")
        self.assertEqual(str(caught.exception), "git ls-tree HEAD: � bad")

    def test_bad_rev_message(self):
        with self.assertRaises(sync.SyncError) as caught:
            sync.GitSource(self.root, "--x")
        self.assertEqual(str(caught.exception), "zła nazwa rewizji: '--x'")

    def test_rev_charset(self):
        for rev in ("main", "refs/pull/1/head", "a.b_c-d", "0123abc", "FETCH_HEAD"):
            with self.subTest(rev=rev):
                sync.GitSource(self.root, rev)
        for rev in ("-main", "a b", "a..b", "a~1", "a:b", ".hidden", "a\nb"):
            with self.subTest(rev=rev):
                with self.assertRaises(sync.SyncError):
                    sync.GitSource(self.root, rev)

    def test_git_invocation_targets_the_given_root(self):
        source = sync.GitSource(self.root, "HEAD")
        self.assertEqual(source.git("rev-parse", "--show-toplevel").stdout.decode().strip().lower().replace("\\", "/"),
                         str(self.root).lower().replace("\\", "/"))


class LossyAndTextTests(unittest.TestCase):
    def test_lossy_replaces_and_strips(self):
        self.assertEqual(sync.lossy(b"  a\xffb \n"), "a�b")

    def test_text_of(self):
        self.assertEqual(sync.text_of("żółć".encode("utf-8")), "żółć")
        self.assertIsNone(sync.text_of(b"\xff"))

    def test_entry_finding_unicode_block_hash(self):
        text = "# repo-standard:begin x\nżółć\n# repo-standard:end x\n"
        entry = {"path": "d.yml", "kind": "block", "block": "x", "sha256": sync.sha256("żółć\n".encode("utf-8"))}
        self.assertEqual(sync.entry_finding(entry, text.encode("utf-8")), [])

    def test_block_markers_must_be_exact_ids(self):
        self.assertIsNone(sync.block_of("# repo-standard:begin xy\nA\n# repo-standard:end xy\n", "x"))

    def test_replace_block_replaces_only_first_pair(self):
        text = "# repo-standard:begin x\nA\n# repo-standard:end x\n"
        self.assertEqual(sync.replace_block(text, "x", "B\nC\n"), "# repo-standard:begin x\nB\nC\n# repo-standard:end x\n")


class BuildManifestTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.manifest = helpers.make_source(self.root)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = build_manifest.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_refresh_updates_sums_and_keeps_entries(self):
        helpers.put(self.root / ".github/standard/tool.py", "changed\n")
        code, out, _ = self.run_main("--root", str(self.root))
        self.assertEqual(code, 0)
        self.assertEqual(out, "manifest.json: 6 plików, wersja v1.0.0\n")
        written = json.loads((self.root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(written["files"][0]["sha256"], sync.sha256(b"changed\n"))
        self.assertEqual(written["files"][0]["critical"], True)
        self.assertEqual(written["files"][5], PARAM)
        self.assertEqual(sync.check_self(written, self.root), [])
        raw = (self.root / "manifest.json").read_bytes()
        self.assertTrue(raw.endswith(b"\n"))
        self.assertIn(b'\n  "files": [\n', raw)
        self.assertNotIn(b"\r", raw)

    def test_version_flag_sets_version(self):
        code, out, _ = self.run_main("--root", str(self.root), "--version", "v2.3.4")
        self.assertEqual(code, 0)
        self.assertEqual(out, "manifest.json: 6 plików, wersja v2.3.4\n")
        self.assertEqual(json.loads((self.root / "manifest.json").read_text(encoding="utf-8"))["version"], "v2.3.4")

    def test_bad_version_flag_is_rejected_and_file_untouched(self):
        before = (self.root / "manifest.json").read_bytes()
        code, _, err = self.run_main("--root", str(self.root), "--version", "2.0")
        self.assertEqual(code, 2)
        self.assertEqual(err, "build_manifest: wersja musi mieć postać v1.2.3: '2.0'\n")
        self.assertEqual((self.root / "manifest.json").read_bytes(), before)

    def test_missing_source_file(self):
        (self.root / "seeds/config.yml").unlink()
        code, _, err = self.run_main("--root", str(self.root))
        self.assertEqual(code, 2)
        self.assertEqual(err, "build_manifest: seeds/config.yml: brak pliku\n")

    def test_missing_block_markers(self):
        helpers.put(self.root / ".github/dependabot.yml", "version: 2\n")
        code, _, err = self.run_main("--root", str(self.root))
        self.assertEqual(code, 2)
        self.assertEqual(err, "build_manifest: .github/dependabot.yml: brak znaczników bloku 'github-actions'\n")

    def test_missing_manifest_and_invalid_manifest(self):
        (self.root / "manifest.json").unlink()
        self.assertEqual(self.run_main("--root", str(self.root))[0], 2)
        helpers.put(self.root / "manifest.json", "{}")
        self.assertEqual(self.run_main("--root", str(self.root))[0], 2)

    def test_default_root_is_current_directory(self):
        previous = Path.cwd()
        import os
        os.chdir(self.root)
        try:
            code, _, _ = self.run_main()
        finally:
            os.chdir(previous)
        self.assertEqual(code, 0)

    def test_block_sum_is_of_block_text_and_source_is_used(self):
        refreshed = build_manifest.refreshed(self.manifest, self.root)
        block = sync.block_of((self.root / ".github/dependabot.yml").read_text(encoding="utf-8"), "github-actions")
        self.assertEqual(refreshed["files"][3]["sha256"], sync.sha256(block.encode("utf-8")))
        self.assertEqual(refreshed["files"][4]["sha256"], sync.sha256((self.root / "seeds/config.yml").read_bytes()))

    def test_non_ascii_content_is_written_as_utf8(self):
        manifest = json.loads((self.root / "manifest.json").read_text(encoding="utf-8"))
        manifest["files"][3]["skeleton"] = "# żółć\nversion: 2\nupdates:\n"
        helpers.put(self.root / "manifest.json", json.dumps(manifest, ensure_ascii=False))
        self.assertEqual(self.run_main("--root", str(self.root))[0], 0)
        self.assertIn("żółć".encode("utf-8"), (self.root / "manifest.json").read_bytes())

    def test_refreshed_does_not_mutate_input(self):
        original = json.dumps(self.manifest, sort_keys=True)
        helpers.put(self.root / ".github/standard/tool.py", "changed\n")
        build_manifest.refreshed(self.manifest, self.root)
        self.assertEqual(json.dumps(self.manifest, sort_keys=True), original)


class GitSegmentTests(unittest.TestCase):
    def test_git_directory_is_rejected_in_path_and_source(self):
        for path in (".git/hooks/pre-commit", "a/.GIT/x", ".git"):
            with self.subTest(path=path):
                self.assertEqual(sync.entry_errors(0, {**ENTRY, "path": path}), ["files[0].path: oczekiwano bezpiecznej ścieżki względnej"])
                self.assertEqual(sync.entry_errors(0, {**ENTRY, "source": path}), ["files[0].source: oczekiwano bezpiecznej ścieżki względnej"])

    def test_similar_names_are_allowed(self):
        for path in (".github/x.yml", ".gitattributes", "a.git/x", "x.gitignore", ".gitleaks.toml"):
            with self.subTest(path=path):
                self.assertEqual(sync.entry_errors(0, {**ENTRY, "path": path}), [])
                self.assertTrue(sync.safe_manifest_path(path))
        self.assertFalse(sync.safe_manifest_path(5))


class LateMutantTests(Workspace):
    def test_redirect_delegates_all_arguments_to_parent(self):
        request = urllib.request.Request("https://h.example.invalid/a")
        with mock.patch.object(urllib.request.HTTPRedirectHandler, "redirect_request", return_value="sentinel") as parent:
            result = sync.SameHostHttps().redirect_request(request, "fp", 302, "Found", {"k": "v"}, "https://h.example.invalid/b")
        self.assertEqual(result, "sentinel")
        parent.assert_called_once_with(request, "fp", 302, "Found", {"k": "v"}, "https://h.example.invalid/b")

    def test_verify_issues_continues_after_foreign_repository(self):
        overrides = [{"path": "a", "reason": "r", "until": "2026-07-01", "issue": "x/y#1"},
                     {"path": "b", "reason": "r", "until": "2026-07-01", "issue": "org/repo#2"}]
        findings = sync.verify_issues(overrides, lambda url, token: b'{"state": "closed", "labels": []}', None, "org/repo")
        self.assertEqual(findings, ["odstępstwo a: zgłoszenie x/y#1 nie należy do repozytorium org/repo",
                                    "odstępstwo b: zgłoszenie org/repo#2 musi być otwarte i mieć audit:ok"])

    def test_pin_change_finding_text(self):
        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        git(self.dst, "init", "-q", "-b", "main")
        git(self.dst, "add", "-A")
        git(self.dst, "commit", "-q", "-m", "base")
        trusted = self.dst / "trusted.json"
        trusted.write_bytes((self.dst / ".github/repo-standard.json").read_bytes())
        self.set_params(standard={"version": "v1.0.0", "sha": helpers.OTHER_SHA})
        git(self.dst, "commit", "-q", "-am", "pr")
        code, out = self.check("--tree", "HEAD", "--params", str(trusted))
        self.assertEqual(code, 1)
        self.assertIn("- przypięcie wzorca (standard.version, standard.sha) różni się od zaufanego pliku parametrów: zmiana wymaga wydania i akceptacji", out.splitlines())


if __name__ == "__main__":
    unittest.main()
