"""The production exporter observes real bare Git history and rejects unsafe trees."""

import importlib
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))


class HostSourceTests(unittest.TestCase):
    def test_real_bare_tree_exports_exact_sha_and_rejects_symlinks(self):
        module = importlib.import_module("host_source")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            source = root / "work"
            source.mkdir()
            environment = dict(
                os.environ,
                GIT_AUTHOR_NAME="Test",
                GIT_AUTHOR_EMAIL="test@example.invalid",
                GIT_COMMITTER_NAME="Test",
                GIT_COMMITTER_EMAIL="test@example.invalid",
            )

            def git(*args):
                return (
                    subprocess.check_output(
                        ["git", "-C", str(source), *args],
                        env=environment,
                        stderr=subprocess.DEVNULL,
                    )
                    .decode()
                    .strip()
                )

            git("init", "-q", "-b", "main")
            (source / "public.txt").write_text("first")
            git("add", ".")
            git("commit", "-qm", "first")
            first = git("rev-parse", "HEAD")
            (source / "public.txt").write_text("second")
            git("commit", "-qam", "second")
            bare = root / "cache.git"
            subprocess.run(
                ["git", "clone", "--quiet", "--bare", str(source), str(bare)], check=True
            )
            output = root / "export"
            module.export_tree(
                bare,
                first,
                output,
                importlib.import_module("host_io").command_environment(os.getuid()),
            )
            self.assertEqual((output / "public.txt").read_text(), "first")
            self.assertEqual(list(p.name for p in output.iterdir()), ["public.txt"])
            (source / "link").symlink_to("/etc/passwd")
            git("add", ".")
            git("commit", "-qm", "unsafe")
            subprocess.run(
                ["git", "--git-dir", str(bare), "fetch", "--quiet", str(source), "main"], check=True
            )
            unsafe = git("rev-parse", "HEAD")
            with self.assertRaisesRegex(Exception, "deployment_input_failed"):
                module.export_tree(
                    bare,
                    unsafe,
                    root / "rejected",
                    importlib.import_module("host_io").command_environment(os.getuid()),
                )
            self.assertFalse((root / "rejected").exists())
            self.assertEqual((output / "public.txt").read_text(), "first")


if __name__ == "__main__":
    unittest.main()
