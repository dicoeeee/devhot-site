"""Filesystem and process boundaries of the production host adapter."""

import importlib
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))


class HostIoTests(unittest.TestCase):
    def test_metadata_detects_alias_and_protected_json_rejects_user_owned_file(self):
        io = importlib.import_module("host_io")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            data = root / "instance.json"
            data.write_text("{}")
            data.chmod(0o600)
            alias = root / "alias"
            alias.symlink_to(data)
            self.assertTrue(io.metadata(data)["canonical"])
            self.assertFalse(io.metadata(alias)["canonical"])
            with self.assertRaisesRegex(Exception, "deployment_untrusted_configuration"):
                io.read_root_json(data, os.getgid())
            with self.assertRaisesRegex(Exception, "deployment_untrusted_configuration"):
                io.read_root_json(alias, os.getgid())

    def test_ancestor_policy_rejects_writable_parents_and_symlinks(self):
        check = importlib.import_module("host_io").secure_directory_ancestors
        self.assertTrue(check(pathlib.Path("/usr"), os.getuid()))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            child = root / "private"
            child.mkdir(mode=0o700)
            root.chmod(0o777)
            self.assertFalse(check(child, os.getuid()))
            alias = root / "alias"
            alias.symlink_to(child, target_is_directory=True)
            self.assertFalse(check(alias, os.getuid()))

    def test_output_limit_stops_a_noisy_process_before_its_sleep_timeout(self):
        module = importlib.import_module("host_io")
        with self.assertRaisesRegex(Exception, "^deployment_command_output_limit$"):
            module.run(
                [
                    "/usr/bin/python3",
                    "-c",
                    "import sys,time;sys.stdout.write('x'*65536);sys.stdout.flush();time.sleep(10)",
                ],
                module.command_environment(1001),
                limit=1024,
                timeout=2,
            )

    def test_commands_use_explicit_environment_and_fixed_error_without_raw_output(self):
        io = importlib.import_module("host_io")
        environment = io.command_environment(1001)
        self.assertEqual(environment["DOCKER_CONFIG"], "/etc/devhot-site/docker-client")
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertNotIn("GIT_CONFIG", environment)
        self.assertEqual(environment["HOME"], "/nonexistent")
        self.assertEqual(io.run(["/usr/bin/printf", "%s", "public"], environment).stdout, "public")
        with self.assertRaisesRegex(Exception, "^deployment_command_failed$"):
            io.run(["/bin/sh", "-c", "echo SECRET >&2; exit 1"], environment)
        with self.assertRaisesRegex(Exception, "^deployment_command_timeout$"):
            io.run(["/bin/sleep", "2"], environment, timeout=0.05)


if __name__ == "__main__":
    unittest.main()
