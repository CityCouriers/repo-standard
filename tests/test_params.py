import json
import unittest

import helpers
from common import params


class ValidateTests(unittest.TestCase):
    def errors(self, **changes):
        return params.validate(helpers.valid_params(**changes))

    def test_valid_params_pass(self):
        self.assertEqual(self.errors(), [])

    def test_not_an_object(self):
        self.assertEqual(params.validate([]), ["plik parametrów: oczekiwano obiektu JSON"])

    def test_unknown_and_missing_top_keys(self):
        data = helpers.valid_params(extra=1)
        del data["audit"]
        errors = params.validate(data)
        self.assertIn("nieznany klucz 'extra'", errors)
        self.assertIn("brak klucza 'audit'", errors)

    def test_schema_must_be_one(self):
        self.assertEqual(self.errors(schema=2), ["schema: oczekiwano 1, jest 2"])

    def test_standard_version_and_sha(self):
        self.assertTrue(any("standard.version" in e for e in self.errors(standard={"version": "1.0.0", "sha": helpers.SHA})))
        self.assertTrue(any("standard.version" in e for e in self.errors(standard={"version": "v1.0", "sha": helpers.SHA})))
        for sha in ("a" * 39, "A" * 40, "g" * 40, 5):
            with self.subTest(sha=sha):
                self.assertTrue(any("standard.sha" in e for e in self.errors(standard={"version": "v1.0.0", "sha": sha})))

    def test_standard_unknown_and_missing_keys(self):
        errors = self.errors(standard={"version": "v1.0.0", "sha": helpers.SHA, "x": 1})
        self.assertEqual(errors, ["standard: nieznany klucz 'x'"])
        self.assertEqual(self.errors(standard={"version": "v1.0.0"}), ["standard: brak klucza 'sha'"])
        self.assertEqual(self.errors(standard="v1"), ["standard: oczekiwano obiektu"])

    def test_activation_dates(self):
        for value in ("", "2026-01-01T00:00:00Z"):
            with self.subTest(value=value):
                self.assertEqual(self.errors(audit={"active_since": value}), [])
        for value in ("2026-02-30T00:00:00Z", "2026-01-01T00:00:00", "2026-01-01 00:00:00Z", None, "2026-01-01T00:00:00.5Z"):
            with self.subTest(value=value):
                errors = self.errors(triage={"active_since": value})
                self.assertEqual(len(errors), 1)
                self.assertIn("triage.active_since", errors[0])

    def test_activation_must_be_object_with_one_key(self):
        self.assertEqual(self.errors(audit={}), ["audit: brak klucza 'active_since'"])
        self.assertEqual(self.errors(audit={"active_since": "", "x": 1}), ["audit: nieznany klucz 'x'"])

    def test_quality_gate_rules(self):
        base = helpers.valid_params()["quality_gate"]
        cases = {
            "workflow": {**base, "workflow": "dir/quality.yml"},
            "jobs": {**base, "jobs": []},
            "jobs dup": {**base, "jobs": ["a", "a"]},
            "jobs type": {**base, "jobs": ["a", 1]},
            "unknown": {**base, "extra": 1},
            "required type": {**base, "required": []},
            "required event": {**base, "required": {"pull_request": ["lint"], "push": [], "workflow_dispatch": [], "x": []}},
            "required missing": {**base, "required": {"pull_request": ["lint"], "push": []}},
            "required dup": {**base, "required": {**base["required"], "push": ["tests", "tests"]}},
            "required outside": {**base, "required": {**base["required"], "push": ["zzz"]}},
            "required type list": {**base, "required": {**base["required"], "push": "tests"}},
        }
        for name, value in cases.items():
            with self.subTest(name=name):
                self.assertTrue(self.errors(quality_gate=value), name)

    def test_quality_gate_outside_job_is_named(self):
        base = helpers.valid_params()["quality_gate"]
        errors = self.errors(quality_gate={**base, "required": {**base["required"], "push": ["zzz"]}})
        self.assertEqual(errors, ["quality_gate.required.push: jobów spoza `jobs`: ['zzz']"])

    def test_quality_gate_workflow_accepts_yaml_names(self):
        base = helpers.valid_params()["quality_gate"]
        for name in ("quality.yml", "ci-main.yaml"):
            self.assertEqual(self.errors(quality_gate={**base, "workflow": name}), [])

    def test_review_gate_paths(self):
        self.assertEqual(self.errors(review_gate={"protected_paths": []}), [])
        for path in ("../x", "/x", "a\\b", "a/", "a//b", "./a", "c:/x", "a\x00b", "", " a", 5):
            with self.subTest(path=path):
                self.assertTrue(self.errors(review_gate={"protected_paths": [path]}))
        self.assertTrue(self.errors(review_gate={"protected_paths": "x"}))
        self.assertEqual(self.errors(review_gate={}), ["review_gate: brak klucza 'protected_paths'"])

    def test_overrides(self):
        good = {"path": ".github/workflows/x.yml", "reason": "powod", "until": "2026-12-31", "issue": "org/repo#12"}
        self.assertEqual(self.errors(overrides=[good]), [])
        bad = {
            "path": {**good, "path": "../x"},
            "reason": {**good, "reason": "  "},
            "until": {**good, "until": "2026-13-01"},
            "until format": {**good, "until": "2026-1-1"},
            "issue": {**good, "issue": "org/repo#0"},
            "issue type": {**good, "issue": 5},
            "unknown": {**good, "x": 1},
        }
        for name, entry in bad.items():
            with self.subTest(name=name):
                self.assertEqual(len(self.errors(overrides=[entry])), 1, name)
        self.assertEqual(self.errors(overrides={}), ["overrides: oczekiwano listy"])
        self.assertEqual(self.errors(overrides=["x"]), ["overrides[0]: oczekiwano obiektu"])
        self.assertEqual(self.errors(overrides=[good, good]), ["overrides: powtórzona ścieżka '.github/workflows/x.yml'"])


class LoadTests(unittest.TestCase):
    def test_load_valid(self):
        self.assertEqual(params.load(json.dumps(helpers.valid_params()))["schema"], 1)

    def test_invalid_json(self):
        with self.assertRaises(params.ParamsError) as caught:
            params.load("{")
        self.assertIn("nie jest poprawnym JSON", caught.exception.errors[0])

    def test_duplicate_keys_rejected(self):
        with self.assertRaises(params.ParamsError) as caught:
            params.load('{"schema": 1, "schema": 1}')
        self.assertIn("powtórzone klucze", caught.exception.errors[0])

    def test_schema_errors_raise_with_list(self):
        with self.assertRaises(params.ParamsError) as caught:
            params.load("[]")
        self.assertEqual(caught.exception.errors, ["plik parametrów: oczekiwano obiektu JSON"])
        self.assertEqual(str(caught.exception), "plik parametrów: oczekiwano obiektu JSON")


class VersionTests(unittest.TestCase):
    def test_parse_version(self):
        self.assertEqual(params.parse_version("v1.20.3"), (1, 20, 3))
        for value in ("1.0.0", "v01.0.0", "v1.0", "v1.0.0-rc1", None, 5):
            with self.subTest(value=value):
                self.assertIsNone(params.parse_version(value))


if __name__ == "__main__":
    unittest.main()
