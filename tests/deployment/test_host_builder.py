"""Preparation classification does not turn network errors into failed versions."""

import importlib
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))


class HostBuilderTests(unittest.TestCase):
    def test_dependency_failure_classification_and_fixed_commands(self):
        builder = importlib.import_module("host_builder")
        for value in (
            "npm error code EAI_AGAIN",
            "TypeError: fetch failed; UND_ERR_CONNECT_TIMEOUT",
            "deployment_nginx_source_unavailable",
            "pinned nginx tarball sha256 mismatch",
            "npm error code ECONNRESET",
            "Connection timed out",
            "Temporary failure resolving deb.debian.org",
            "Failed to download browser",
        ):
            with self.subTest(value=value):
                self.assertEqual(builder.preparation_failure(value), "prepare")
        for value in (
            "npm error code ETARGET",
            "npm error code EUSAGE",
            "package-lock.json mismatch",
            "npm error code E401",
            "Unknown SECRET failure",
        ):
            with self.subTest(value=value):
                self.assertEqual(builder.preparation_failure(value), "dependencies")
        self.assertIn("npm ci", builder.PREPARE_COMMAND)
        self.assertNotIn("npm run gate", builder.PREPARE_COMMAND)
        self.assertIn("npm run gate", builder.BUILD_COMMAND)
        self.assertNotIn("skip", builder.BUILD_COMMAND)


if __name__ == "__main__":
    unittest.main()
