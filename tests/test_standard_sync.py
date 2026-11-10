import copy
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date
from pathlib import Path

import helpers
import standard_sync as sync
from common import params as params_module

TODAY = date(2026, 6, 1)


class Workspace(unittest.TestCase):
    """Syntetyczne repozytorium wzorca (`self.src`) i pusty konsument (`self.dst`)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.src, self.dst = Path(tmp.name) / "src", Path(tmp.name) / "dst"
        self.src.mkdir()
        self.dst.mkdir()
        self.manifest = helpers.make_source(self.src)
        self.fetch = helpers.serve(self.src, tags={"v1.0.0": helpers.SHA})
        self.env = {}

    def run_main(self, *argv, fetch=None):
        out = io.StringIO()
        with redirect_stdout(out):
            code = sync.main(list(argv), self.env, fetch or self.fetch, TODAY)
        return code, out.getvalue()

    def apply_clean(self):
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 0, out)

    def check(self, *extra):
        return self.run_main("check", "--root", str(self.dst), *extra)

    def set_params(self, **changes):
        data = json.loads((self.dst / ".github/repo-standard.json").read_text(encoding="utf-8"))
        data.update(changes)
        helpers.put(self.dst / ".github/repo-standard.json", json.dumps(data))

    def override(self, path, until="2026-07-01", issue="org/repo#5"):
        return {"path": path, "reason": "powod", "until": until, "issue": issue}


class BlockTests(unittest.TestCase):
    TEXT = "a\n# repo-standard:begin x\none\ntwo\n# repo-standard:end x\nb\n"

    def test_block_of_extracts_inner_lines(self):
        self.assertEqual(sync.block_of(self.TEXT, "x"), "one\ntwo\n")

    def test_block_of_empty_block(self):
        self.assertEqual(sync.block_of("# repo-standard:begin x\n# repo-standard:end x\n", "x"), "")

    def test_block_of_requires_exactly_one_pair_in_order(self):
        self.assertIsNone(sync.block_of("none\n", "x"))
        self.assertIsNone(sync.block_of("# repo-standard:begin x\n", "x"))
        self.assertIsNone(sync.block_of("# repo-standard:end x\n# repo-standard:begin x\n", "x"))
        self.assertIsNone(sync.block_of(self.TEXT + self.TEXT, "x"))
        self.assertIsNone(sync.block_of(self.TEXT, "y"))

    def test_block_markers_tolerate_indent(self):
        text = "  # repo-standard:begin x  \n  one\n  # repo-standard:end x\n"
        self.assertEqual(sync.block_of(text, "x"), "  one\n")

    def test_replace_block_keeps_outside(self):
        self.assertEqual(sync.replace_block(self.TEXT, "x", "new\n"),
                         "a\n# repo-standard:begin x\nnew\n# repo-standard:end x\nb\n")

    def test_replace_block_without_markers(self):
        self.assertIsNone(sync.replace_block("plain\n", "x", "new\n"))


class ManifestTests(unittest.TestCase):
    def errors(self, mutate):
        data = copy.deepcopy(helpers.MANIFEST)
        mutate(data)
        return sync.manifest_errors(data)

    def test_fixture_manifest_is_valid(self):
        self.assertEqual(sync.manifest_errors(helpers.MANIFEST), [])

    def test_top_level(self):
        self.assertEqual(sync.manifest_errors([]), ["manifest: oczekiwano obiektu"])
        self.assertTrue(self.errors(lambda m: m.update(schema=2)))
        self.assertTrue(self.errors(lambda m: m.update(version="1.0")))
        self.assertTrue(self.errors(lambda m: m.update(extra=1)))
        self.assertEqual(self.errors(lambda m: m.update(files=[])), ["manifest.files: oczekiwano niepustej listy"])

    def test_entry_basics(self):
        self.assertTrue(self.errors(lambda m: m["files"].append("x")))
        self.assertTrue(self.errors(lambda m: m["files"][0].update(path="../x")))
        self.assertTrue(self.errors(lambda m: m["files"][0].update(source="/x")))
        self.assertTrue(self.errors(lambda m: m["files"][0].update(kind="other")))
        self.assertTrue(self.errors(lambda m: m["files"][0].update(extra=1)))
        self.assertTrue(self.errors(lambda m: m["files"][2].update(overridable="yes")))
        self.assertTrue(self.errors(lambda m: m["files"][0].update(sha256="zz")))
        self.assertTrue(self.errors(lambda m: m["files"][0].pop("sha256")))

    def test_duplicate_path(self):
        errors = self.errors(lambda m: m["files"].append(dict(m["files"][2])))
        self.assertEqual(errors, ["manifest: powtórzona ścieżka '.github/workflows/lint.yml'"])

    def test_param_entry(self):
        self.assertTrue(self.errors(lambda m: m["files"][5].update(path="other.json")))
        self.assertTrue(self.errors(lambda m: m["files"][5].update(sha256="0" * 64)))

    def test_block_entry(self):
        self.assertTrue(self.errors(lambda m: m["files"][3].update(block="Bad Id")))
        self.assertTrue(self.errors(lambda m: m["files"][3].pop("block")))
        self.assertTrue(self.errors(lambda m: m["files"][3].update(skeleton=5)))
        self.assertTrue(self.errors(lambda m: m["files"][2].update(block="x")))
        self.assertTrue(self.errors(lambda m: m["files"][2].update(skeleton="x")))

    def test_seed_entry(self):
        self.assertTrue(self.errors(lambda m: m["files"][4].update(markers=[])))
        self.assertTrue(self.errors(lambda m: m["files"][4].pop("markers")))
        self.assertTrue(self.errors(lambda m: m["files"][2].update(markers=["x"])))

    def test_critical_rules(self):
        self.assertTrue(self.errors(lambda m: m["files"][0].update(overridable=True)))
        self.assertTrue(self.errors(lambda m: m["files"][3].update(critical=True)))
        self.assertTrue(self.errors(lambda m: m["files"][4].update(critical=True)))

    def test_parse_manifest(self):
        self.assertEqual(sync.parse_manifest(json.dumps(helpers.MANIFEST))["version"], "v1.0.0")
        with self.assertRaises(sync.SyncError):
            sync.parse_manifest("{")
        with self.assertRaises(sync.SyncError):
            sync.parse_manifest('{"schema": 1, "schema": 1}')
        with self.assertRaises(sync.SyncError) as caught:
            sync.parse_manifest("[]")
        self.assertIn("manifest niepoprawny", str(caught.exception))


class CheckCleanAndNegativeTests(Workspace):
    """AC-02: czysta kopia daje 0; pięć negatywów daje 1."""

    def setUp(self):
        super().setUp()
        self.apply_clean()

    def test_clean_copy_is_green(self):
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("pliki zgodne z manifestem", out)

    def test_changed_exact_file_is_red(self):
        helpers.put(self.dst / ".github/standard/tool.py", "print('x')\n")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn(".github/standard/tool.py: rozjazd", out)

    def test_changed_block_is_red_and_outside_block_is_free(self):
        path = self.dst / ".github/dependabot.yml"
        text = path.read_text(encoding="utf-8")
        helpers.put(path, text + "  - package-ecosystem: npm\n    directory: /\n")
        self.assertEqual(self.check()[0], 0)
        helpers.put(path, text.replace("saturday", "monday"))
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("rozjazd bloku 'github-actions'", out)

    def test_missing_block_markers_is_red(self):
        helpers.put(self.dst / ".github/dependabot.yml", "version: 2\nupdates: []\n")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("brak znaczników bloku", out)

    def test_removed_seed_marker_is_red(self):
        helpers.put(self.dst / ".github/ISSUE_TEMPLATE/config.yml", "contact_links: []\n")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("brak znacznika 'blank_issues_enabled: false'", out)

    def test_changed_seed_outside_markers_is_green(self):
        helpers.put(self.dst / ".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\nlocal: 1\n")
        self.assertEqual(self.check()[0], 0)

    def test_expired_override_is_red(self):
        self.set_params(overrides=[self.override(".github/workflows/lint.yml", until="2026-05-31")])
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("odstępstwo wygasło 2026-05-31", out)

    def test_override_for_critical_file_is_red_even_when_file_matches(self):
        self.set_params(overrides=[self.override(".github/standard/tool.py")])
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("odstępstwo dla pliku krytycznego jest niedozwolone", out)

    def test_missing_file_is_red(self):
        (self.dst / ".github/workflows/lint.yml").unlink()
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn(".github/workflows/lint.yml: brak pliku", out)

    def test_non_utf8_block_file_is_red(self):
        (self.dst / ".github/dependabot.yml").write_bytes(b"\xff\xfe")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("nie jest poprawnym UTF-8", out)

    def test_missing_params_file_is_error_two(self):
        (self.dst / ".github/repo-standard.json").unlink()
        self.assertEqual(self.check()[0], 2)

    def test_invalid_params_file_is_error_two(self):
        helpers.put(self.dst / ".github/repo-standard.json", "{}")
        code, out = self.check()
        self.assertEqual(code, 2)
        self.assertIn("niepoprawny", out)

    def test_manifest_version_must_match_pin(self):
        self.set_params(standard={"version": "v1.0.1", "sha": helpers.SHA})
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("a plik parametrów mówi v1.0.1", out)

    def test_fetch_failure_is_error_two(self):
        self.set_params(standard={"version": "v1.0.0", "sha": helpers.OTHER_SHA})
        code, out = self.check()
        self.assertEqual(code, 2)
        self.assertIn("standard_sync: przerwano", out)

    def test_symlinked_file_counts_as_missing(self):
        target = self.dst / ".github/workflows/lint.yml"
        copy_path = self.dst / "real.yml"
        copy_path.write_bytes(target.read_bytes())
        target.unlink()
        try:
            target.symlink_to(copy_path)
        except (OSError, NotImplementedError):
            self.skipTest("brak uprawnień do dowiązań symbolicznych")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("brak pliku", out)


class OverrideTests(Workspace):
    def setUp(self):
        super().setUp()
        self.apply_clean()

    def test_valid_override_skips_overridable_file(self):
        helpers.put(self.dst / ".github/workflows/lint.yml", "name: local\n")
        self.assertEqual(self.check()[0], 1)
        self.set_params(overrides=[self.override(".github/workflows/lint.yml")])
        self.assertEqual(self.check()[0], 0)

    def test_override_for_unknown_path_is_red(self):
        self.set_params(overrides=[self.override(".github/workflows/zzz.yml")])
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("spoza manifestu", out)

    def test_override_for_non_overridable_file_is_red(self):
        self.set_params(overrides=[self.override(".github/dependabot.yml")])
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("plik nie dopuszcza odstępstwa", out)

    def test_override_longer_than_ninety_days_is_red(self):
        self.set_params(overrides=[self.override(".github/workflows/lint.yml", until="2026-08-30")])
        self.assertEqual(self.check()[0], 0)
        self.set_params(overrides=[self.override(".github/workflows/lint.yml", until="2026-08-31")])
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("dalszym niż 90 dni", out)

    def test_override_due_today_is_still_valid(self):
        self.set_params(overrides=[self.override(".github/workflows/lint.yml", until="2026-06-01")])
        self.assertEqual(self.check()[0], 0)

    def test_expired_override_still_checks_file(self):
        helpers.put(self.dst / ".github/workflows/lint.yml", "name: local\n")
        self.set_params(overrides=[self.override(".github/workflows/lint.yml", until="2026-01-01")])
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("wygasło", out)
        self.assertIn("lint.yml: rozjazd", out)

    def test_verify_issues_requires_open_issue_with_audit_ok(self):
        self.set_params(overrides=[self.override(".github/workflows/lint.yml", issue="org/repo#5")])
        self.env = {"GITHUB_REPOSITORY": "org/repo"}
        for payload, expected in (
            ({"state": "open", "labels": [{"name": "audit:ok"}]}, 0),
            ({"state": "closed", "labels": [{"name": "audit:ok"}]}, 1),
            ({"state": "open", "labels": [{"name": "audit:pending"}]}, 1),
            ({"state": "open"}, 1),
        ):
            with self.subTest(payload=payload):
                def fetch(url, token, payload=payload):
                    if url == "https://api.github.com/repos/org/repo/issues/5":
                        return json.dumps(payload).encode()
                    return self.fetch(url, token)

                self.assertEqual(self.run_main("check", "--root", str(self.dst), "--verify-issues", fetch=fetch)[0], expected)

    def test_verify_issues_fail_closed_on_lookup_error_and_passes_token(self):
        self.set_params(overrides=[self.override(".github/workflows/lint.yml")])
        self.env = {"GH_TOKEN": "synthetic-token", "GITHUB_REPOSITORY": "org/repo"}
        tokens = []

        def fetch(url, token):
            if "api.github.com/repos/org/repo/issues" in url:
                tokens.append(token)
                raise sync.SyncError("403")
            return self.fetch(url, token)

        code, out = self.run_main("check", "--root", str(self.dst), "--verify-issues", fetch=fetch)
        self.assertEqual(code, 1)
        self.assertIn("nie można zweryfikować zgłoszenia org/repo#5", out)
        self.assertEqual(tokens, ["synthetic-token"])

    def test_verify_issues_falls_back_to_github_token(self):
        self.set_params(overrides=[self.override(".github/workflows/lint.yml")])
        self.env = {"GITHUB_TOKEN": "fallback", "GITHUB_REPOSITORY": "org/repo"}
        tokens = []

        def fetch(url, token):
            if "issues/5" in url:
                tokens.append(token)
                return b'{"state": "open", "labels": [{"name": "audit:ok"}]}'
            return self.fetch(url, token)

        self.assertEqual(self.run_main("check", "--root", str(self.dst), "--verify-issues", fetch=fetch)[0], 0)
        self.assertEqual(tokens, ["fallback"])

    def test_without_verify_issues_no_issue_lookup(self):
        self.set_params(overrides=[self.override(".github/workflows/lint.yml")])
        self.fetch.calls.clear()
        self.check()
        self.assertFalse([url for url in self.fetch.calls if "api.github.com" in url])


class ApplyTests(Workspace):
    def test_apply_writes_files_and_params(self):
        self.apply_clean()
        for path, text in helpers.SOURCE_FILES.items():
            if path.startswith("seeds/"):
                continue
            if path != ".github/dependabot.yml":
                self.assertEqual((self.dst / path).read_text(encoding="utf-8"), text)
        self.assertEqual((self.dst / ".github/ISSUE_TEMPLATE/config.yml").read_text(encoding="utf-8"), helpers.SOURCE_FILES["seeds/config.yml"])
        dependabot = (self.dst / ".github/dependabot.yml").read_text(encoding="utf-8")
        self.assertTrue(dependabot.startswith("version: 2\nupdates:\n# repo-standard:begin github-actions\n"))
        self.assertTrue(dependabot.endswith("# repo-standard:end github-actions\n"))
        params = json.loads((self.dst / ".github/repo-standard.json").read_text(encoding="utf-8"))
        self.assertEqual(params["standard"], {"version": "v1.0.0", "sha": helpers.SHA})
        self.assertEqual(params_module.validate(params), [])
        self.assertTrue((self.dst / ".github/repo-standard.json").read_text(encoding="utf-8").endswith("}\n"))

    def test_apply_dry_run_writes_nothing(self):
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst), "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("do zapisu", out)
        self.assertIn("(dry-run)", out)
        self.assertEqual(list(self.dst.iterdir()), [])

    def test_apply_by_sha(self):
        code, _ = self.run_main("apply", "--sha", helpers.SHA, "--root", str(self.dst))
        self.assertEqual(code, 0)
        self.assertEqual(self.check()[0], 0)

    def test_apply_needs_exactly_one_selector(self):
        self.assertEqual(self.run_main("apply", "--root", str(self.dst))[0], 2)
        self.assertEqual(self.run_main("apply", "--version", "v1.0.0", "--sha", helpers.SHA, "--root", str(self.dst))[0], 2)

    def test_apply_keeps_existing_params_and_overrides(self):
        self.apply_clean()
        override = self.override(".github/workflows/lint.yml")
        self.set_params(overrides=[override], review_gate={"protected_paths": ["x.toml"]})
        helpers.put(self.dst / ".github/workflows/lint.yml", "name: local\n")
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 0)
        self.assertIn("lint.yml: pominięty (ważne odstępstwo)", out)
        self.assertEqual((self.dst / ".github/workflows/lint.yml").read_text(encoding="utf-8"), "name: local\n")
        params = json.loads((self.dst / ".github/repo-standard.json").read_text(encoding="utf-8"))
        self.assertEqual(params["overrides"], [override])
        self.assertEqual(params["review_gate"], {"protected_paths": ["x.toml"]})

    def test_apply_overwrites_critical_file_even_with_override_entry(self):
        self.apply_clean()
        helpers.put(self.dst / ".github/standard/tool.py", "evil\n")
        self.set_params(overrides=[self.override(".github/standard/tool.py")])
        self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual((self.dst / ".github/standard/tool.py").read_text(encoding="utf-8"), "print('tool')\n")

    def test_apply_leaves_existing_seed(self):
        self.apply_clean()
        seed = self.dst / ".github/ISSUE_TEMPLATE/config.yml"
        helpers.put(seed, "blank_issues_enabled: false\nlocal: 1\n")
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 0)
        self.assertIn("seed już istnieje, zostawiony", out)
        self.assertIn("local: 1", seed.read_text(encoding="utf-8"))

    def test_apply_replaces_block_in_existing_file_keeping_rest(self):
        self.apply_clean()
        path = self.dst / ".github/dependabot.yml"
        text = path.read_text(encoding="utf-8").replace("saturday", "monday") + "  - package-ecosystem: npm\n"
        helpers.put(path, text)
        self.assertEqual(self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))[0], 0)
        result = path.read_text(encoding="utf-8")
        self.assertIn("day: saturday", result)
        self.assertTrue(result.endswith("  - package-ecosystem: npm\n"))
        self.assertEqual(self.check()[0], 0)

    def test_apply_refuses_block_file_without_markers_and_writes_nothing(self):
        (self.dst / ".github").mkdir()
        helpers.put(self.dst / ".github/dependabot.yml", "version: 2\n")
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn("istnieje bez znaczników bloku", out)
        self.assertFalse((self.dst / ".github/standard").exists())
        self.assertFalse((self.dst / ".github/repo-standard.json").exists())

    def test_apply_rejects_tampered_exact_file_and_writes_nothing(self):
        helpers.put(self.src / ".github/workflows/lint.yml", "name: tampered\n")
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn("nie zgadza się z sumą", out)
        self.assertEqual(list(self.dst.iterdir()), [])

    def test_apply_rejects_tampered_block(self):
        text = (self.src / ".github/dependabot.yml").read_text(encoding="utf-8").replace("saturday", "monday")
        helpers.put(self.src / ".github/dependabot.yml", text)
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn("ze źródła nie zgadza się z manifestem", out)

    def test_apply_rejects_non_utf8_block_source(self):
        (self.src / ".github/dependabot.yml").write_bytes(b"\xff\xfe")
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn("ze źródła nie zgadza się z manifestem", out)

    def test_apply_rejects_tag_manifest_version_mismatch(self):
        fetch = helpers.serve(self.src, tags={"v1.0.1": helpers.SHA})
        code, out = self.run_main("apply", "--version", "v1.0.1", "--root", str(self.dst), fetch=fetch)
        self.assertEqual(code, 2)
        self.assertIn("wskazuje manifest wersji v1.0.0", out)

    def test_apply_unknown_tag_is_error(self):
        self.assertEqual(self.run_main("apply", "--version", "v9.9.9", "--root", str(self.dst))[0], 2)

    def test_apply_refuses_symlinked_parent(self):
        outside = self.dst.parent / "outside"
        outside.mkdir()
        try:
            (self.dst / ".github").symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("brak uprawnień do dowiązań symbolicznych")
        code, out = self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn("dowiązanie symboliczne", out)
        self.assertEqual(list(outside.iterdir()), [])

    def test_apply_with_invalid_existing_params_is_error(self):
        (self.dst / ".github").mkdir()
        helpers.put(self.dst / ".github/repo-standard.json", "{}")
        self.assertEqual(self.run_main("apply", "--version", "v1.0.0", "--root", str(self.dst))[0], 2)

    def test_apply_custom_repo_is_used_in_urls(self):
        self.fetch.calls.clear()
        self.run_main("apply", "--sha", helpers.SHA, "--root", str(self.dst), "--repo", "Other-Org/standard.copy", fetch=self.fetch)
        self.assertEqual(self.fetch.calls, [f"https://raw.githubusercontent.com/Other-Org/standard.copy/{helpers.SHA}/manifest.json"])

    def test_default_params_are_valid_and_inactive(self):
        params = sync.default_params()
        params["standard"] = {"version": "v1.0.0", "sha": helpers.SHA}
        self.assertEqual(params_module.validate(params), [])
        self.assertEqual(params["audit"]["active_since"], "")
        self.assertEqual(params["triage"]["active_since"], "")


class ResolveTagTests(unittest.TestCase):
    def test_lightweight_tag(self):
        def fetch(url, token):
            self.assertEqual(url, f"https://api.github.com/repos/{helpers.REPO}/git/ref/tags/v1.0.0")
            return json.dumps({"object": {"type": "commit", "sha": helpers.SHA}}).encode()

        self.assertEqual(sync.resolve_tag(helpers.REPO, "v1.0.0", fetch), helpers.SHA)

    def test_annotated_tag_is_dereferenced(self):
        def fetch(url, token):
            if url.endswith("/git/ref/tags/v1.0.0"):
                return json.dumps({"object": {"type": "tag", "sha": helpers.OTHER_SHA}}).encode()
            self.assertEqual(url, f"https://api.github.com/repos/{helpers.REPO}/git/tags/{helpers.OTHER_SHA}")
            return json.dumps({"object": {"type": "commit", "sha": helpers.SHA}}).encode()

        self.assertEqual(sync.resolve_tag(helpers.REPO, "v1.0.0", fetch), helpers.SHA)

    def test_tag_pointing_at_non_commit_or_bad_sha(self):
        for obj in ({"type": "tree", "sha": helpers.SHA}, {"type": "commit", "sha": "abc"}):
            with self.subTest(obj=obj):
                with self.assertRaises(sync.SyncError):
                    sync.resolve_tag(helpers.REPO, "v1.0.0", lambda url, token, obj=obj: json.dumps({"object": obj}).encode())

    def test_bad_inputs(self):
        for repo, tag in (("nope", "v1.0.0"), (helpers.REPO, "main"), (helpers.REPO, "v1.0")):
            with self.subTest(repo=repo, tag=tag):
                with self.assertRaises(sync.SyncError):
                    sync.resolve_tag(repo, tag, lambda url, token: b"{}")


class UrlAndHttpTests(unittest.TestCase):
    def test_raw_url_quotes_path(self):
        self.assertEqual(sync.raw_url(helpers.REPO, helpers.SHA, "a b/c.yml"),
                         f"https://raw.githubusercontent.com/{helpers.REPO}/{helpers.SHA}/a%20b/c.yml")

    def test_raw_url_rejects_branch_names_and_bad_repo(self):
        with self.assertRaises(sync.SyncError):
            sync.raw_url(helpers.REPO, "main", "x")
        with self.assertRaises(sync.SyncError):
            sync.raw_url("a/b/c", helpers.SHA, "x")

    def test_http_get_requires_https(self):
        with self.assertRaises(sync.SyncError):
            sync.http_get("http://example.invalid/x")
        with self.assertRaises(sync.SyncError):
            sync.http_get("file:///etc/passwd")


class SelfCheckTests(Workspace):
    def self_check(self):
        return self.run_main("check", "--self", "--root", str(self.src))

    def test_consistent_source_is_green(self):
        code, out = self.self_check()
        self.assertEqual(code, 0, out)
        self.assertIn("6 plików manifestu v1.0.0", out)

    def test_changed_source_file_is_red_and_names_source_path(self):
        helpers.put(self.src / "seeds/config.yml", "other\n")
        code, out = self.self_check()
        self.assertEqual(code, 1)
        self.assertIn("seeds/config.yml: brak znacznika", out)

    def test_changed_exact_file_is_red(self):
        helpers.put(self.src / ".github/standard/tool.py", "changed\n")
        self.assertEqual(self.self_check()[0], 1)

    def test_unlisted_standard_file_is_red(self):
        helpers.put(self.src / ".github/standard/extra.py", "x = 1\n")
        code, out = self.self_check()
        self.assertEqual(code, 1)
        self.assertIn(".github/standard/extra.py: plik wzorca nie jest wpisany do manifestu", out)

    def test_bytecode_and_cache_are_ignored(self):
        cache = self.src / ".github/standard/__pycache__"
        cache.mkdir()
        (cache / "tool.cpython-314.pyc").write_bytes(b"\x00")
        (self.src / ".github/standard/stray.pyc").write_bytes(b"\x00")
        self.assertEqual(self.self_check()[0], 0)

    def test_missing_source_file_is_red(self):
        (self.src / "seeds/config.yml").unlink()
        code, out = self.self_check()
        self.assertEqual(code, 1)
        self.assertIn("seeds/config.yml: brak pliku", out)

    def test_missing_standard_directory_is_not_a_crash(self):
        manifest = {"schema": 1, "version": "v1.0.0", "files": [{"path": "x.txt", "kind": "exact", "sha256": helpers.build_manifest.standard_sync.sha256(b"x")}]}
        (self.src / "x.txt").write_bytes(b"x")
        helpers.put(self.src / "manifest.json", json.dumps(manifest))
        import shutil
        shutil.rmtree(self.src / ".github")
        self.assertEqual(self.self_check()[0], 0)


def git(root: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
                          capture_output=True, text=True, check=True)
    return done.stdout.strip()


class TreeModeTests(Workspace):
    """`--tree`: pliki z commita, pin z zaufanego pliku (AC-11, AC-18)."""

    def setUp(self):
        super().setUp()
        self.apply_clean()
        git(self.dst, "init", "-q", "-b", "main")
        git(self.dst, "add", "-A")
        git(self.dst, "commit", "-q", "-m", "base")
        self.base = git(self.dst, "rev-parse", "HEAD")
        self.trusted = Path(self.dst.parent) / "trusted.json"
        self.trusted.write_bytes((self.dst / ".github/repo-standard.json").read_bytes())

    def commit_head(self, files: dict[str, str]):
        git(self.dst, "checkout", "-q", "-b", "pr")
        helpers.write_tree(self.dst, files)
        git(self.dst, "add", "-A")
        git(self.dst, "commit", "-q", "-m", "pr")
        return git(self.dst, "rev-parse", "HEAD")

    def check_tree(self, rev):
        return self.check("--tree", rev, "--params", str(self.trusted))

    def test_clean_tree_is_green_regardless_of_worktree(self):
        helpers.put(self.dst / ".github/standard/tool.py", "dirty worktree\n")
        code, out = self.check_tree(self.base)
        self.assertEqual(code, 0, out)

    def test_changed_file_in_head_is_red_while_disk_is_irrelevant(self):
        head = self.commit_head({".github/standard/tool.py": "print('own verifier')\n"})
        git(self.dst, "checkout", "-q", "main")
        code, out = self.check_tree(head)
        self.assertEqual(code, 1)
        self.assertIn("tool.py: rozjazd", out)

    def test_override_in_head_params_does_not_help_critical_file(self):
        params = json.loads(self.trusted.read_text(encoding="utf-8"))
        params["overrides"] = [self.override(".github/standard/tool.py")]
        head = self.commit_head({".github/standard/tool.py": "own\n", ".github/repo-standard.json": json.dumps(params)})
        code, out = self.check_tree(head)
        self.assertEqual(code, 1)
        self.assertIn("niedozwolone", out)
        self.assertIn("tool.py: rozjazd", out)

    def test_head_cannot_repin_the_standard(self):
        params = json.loads(self.trusted.read_text(encoding="utf-8"))
        params["standard"] = {"version": "v9.9.9", "sha": helpers.OTHER_SHA}
        head = self.commit_head({".github/repo-standard.json": json.dumps(params)})
        # Pin pochodzi z zaufanego pliku, więc manifest jest pobierany po bazowym SHA, a zmiana pinu w HEAD jest rozjazdem.
        code, out = self.check_tree(head)
        self.assertEqual(code, 1, out)
        self.assertIn("przypięcie wzorca (standard.version, standard.sha) różni się od zaufanego pliku parametrów", out)
        self.assertNotIn(helpers.OTHER_SHA, "\n".join(self.fetch.calls))

    def test_tree_without_trusted_params_is_error_two(self):
        code, out = self.check("--tree", self.base)
        self.assertEqual(code, 2)
        self.assertIn("SyncError: --tree wymaga --params: zaufane przypięcie wzorca musi pochodzić z domyślnej gałęzi, nie z PR", out)

    def test_invalid_head_params_is_error_two(self):
        head = self.commit_head({".github/repo-standard.json": "{}"})
        code, out = self.check_tree(head)
        self.assertEqual(code, 2)
        self.assertIn("w " + head + " niepoprawny", out)

    def test_non_utf8_head_params_is_error_two(self):
        git(self.dst, "checkout", "-q", "-b", "pr")
        (self.dst / ".github/repo-standard.json").write_bytes(b"\xff\xfe")
        git(self.dst, "add", "-A")
        git(self.dst, "commit", "-q", "-m", "pr")
        self.assertEqual(self.check_tree("HEAD")[0], 2)

    def test_missing_head_params_is_error_two(self):
        git(self.dst, "checkout", "-q", "-b", "pr")
        git(self.dst, "rm", "-q", ".github/repo-standard.json")
        git(self.dst, "commit", "-q", "-m", "pr")
        code, out = self.check_tree("HEAD")
        self.assertEqual(code, 2)
        self.assertIn("brak .github/repo-standard.json", out)

    def test_bad_rev_names_are_rejected(self):
        for rev in ("--output=x", "a..b", "", "-x"):
            with self.subTest(rev=rev):
                with self.assertRaises(sync.SyncError):
                    sync.GitSource(self.dst, rev)

    def test_unknown_rev_is_error_two(self):
        self.assertEqual(self.check_tree("deadbeef")[0], 2)

    def test_gitsource_read_missing_and_directory_and_symlink(self):
        source = sync.GitSource(self.dst, self.base)
        self.assertIsNone(source.read("no/such/file"))
        self.assertIsNone(source.read(".github"))
        self.assertEqual(source.read(".github/standard/tool.py"), b"print('tool')\n")

    def test_gitsource_blob_read_failure_is_error(self):
        source = sync.GitSource(self.dst, self.base)
        original = source.git

        def broken(*args):
            if args[0] == "cat-file":
                return subprocess.CompletedProcess(args, 1, b"", b"boom")
            return original(*args)

        source.git = broken
        with self.assertRaises(sync.SyncError) as caught:
            source.read(".github/standard/tool.py")
        self.assertIn("git cat-file", str(caught.exception))

    def test_gitsource_ls_tree_failure_is_error(self):
        source = sync.GitSource(self.dst, "deadbeef")
        with self.assertRaises(sync.SyncError) as caught:
            source.read("x")
        self.assertIn("git ls-tree deadbeef", str(caught.exception))


class SummaryTests(Workspace):
    def test_report_writes_step_summary(self):
        summary = self.dst / "summary.md"
        self.env = {"GITHUB_STEP_SUMMARY": str(summary)}
        self.apply_clean()
        self.check()
        text = summary.read_text(encoding="utf-8")
        self.assertIn("## standard_sync apply v1.0.0", text)
        self.assertIn("## standard_sync check (v1.0.0): zgodne", text)
        self.assertIn("- pliki zgodne z manifestem", text)


class MainTests(unittest.TestCase):
    def test_main_without_command_exits(self):
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            sync.main([], {})

    def test_default_today_is_used_when_not_given(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            with redirect_stdout(out):
                code = sync.main(["check", "--root", tmp], {})
            self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
