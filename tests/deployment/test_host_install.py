"""Default installation inspection and rendering never enable a timer."""

import importlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

PROJECT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "deploy"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
fixtures = importlib.import_module("host_fixtures")


class HostInstallTests(unittest.TestCase):
    def test_cli_render_is_local_and_invalid_config_never_creates_material(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = root / "input.json"
            config.write_text(json.dumps(fixtures.instance()))
            output = root / "package"
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(PROJECT / "deploy/host.py"),
                    "--config",
                    str(config),
                    "render",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / "systemd/user/devhot-site.timer").is_file())
            self.assertFalse(any(path.is_symlink() for path in output.rglob("*")))
            before = {str(path): path.read_bytes() for path in output.rglob("*") if path.is_file()}
            checked = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(PROJECT / "deploy/host.py"),
                    "--config",
                    str(config),
                    "check",
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(checked.returncode, 0)
            self.assertNotIn(str(root), checked.stdout + checked.stderr)
            self.assertEqual(
                before,
                {str(path): path.read_bytes() for path in output.rglob("*") if path.is_file()},
            )
            invalid = fixtures.instance()
            invalid["token"] = "SECRET"
            config.write_text(json.dumps(invalid))
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(PROJECT / "deploy/host.py"),
                    "--config",
                    str(config),
                    "render",
                    "--output",
                    str(root / "invalid"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "invalid").exists())
            self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_installer_defaults_to_readonly_and_refuses_unprivileged_apply(self):
        module = importlib.import_module("host_install")
        for arguments in ([], ["--apply"]):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, "-B", str(PROJECT / "deploy/host_install.py"), *arguments],
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                rows = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertTrue(rows)
                self.assertTrue(all(row["result"] == "failed" for row in rows))
        config = importlib.import_module("host_config").parse_config(fixtures.instance())
        plan = module.installation_files(config)
        self.assertEqual(
            set(plan),
            {
                "/etc/systemd/user/docker.service",
                "/etc/devhot-site/daemon.json",
                "/etc/systemd/user/devhot-site.service",
                "/etc/systemd/user/devhot-site.timer",
                "/etc/devhot-site/compose.json",
            },
        )
        self.assertFalse(any(".wants/" in name for name in plan))


if __name__ == "__main__":
    unittest.main()
