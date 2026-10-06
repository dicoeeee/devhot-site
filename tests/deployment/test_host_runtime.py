"""Cold-start directory preparation on real temporary files, without repair."""

import importlib
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))


class HostRuntimeTests(unittest.TestCase):
    def unprivileged_fixture(self):
        # The fixed CI image runs as root; production preparation must still reject root.
        # Run these real filesystem fixtures with a numeric non-root identity, no groups
        # and a clean environment, without creating an account or skipping a test.
        if os.getuid() != 0:
            return False
        result = subprocess.run(
            [
                "/usr/bin/setpriv",
                "--reuid=65534",
                "--regid=65534",
                "--clear-groups",
                "--no-new-privs",
                sys.executable,
                "-B",
                str(pathlib.Path(__file__).resolve()),
                ".".join(self.id().split(".")[-2:]),
            ],
            env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "TMPDIR": "/tmp"},
            cwd="/",
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return True

    def test_root_cannot_prepare_daemon_runtime_even_with_matching_identity(self):
        prepare = importlib.import_module("host_runtime").prepare_runtime
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            (root / "run/user/0").mkdir(parents=True, mode=0o700)
            with self.assertRaisesRegex(ValueError, "^deployment_runtime_directory_failed$"):
                prepare(0, 0, host_root=root)
            self.assertFalse((root / "run/user/0/docker").exists())

    def test_each_cold_start_prepares_searchable_private_libnetwork_without_chmod(self):
        if self.unprivileged_fixture():
            return
        prepare = importlib.import_module("host_runtime").prepare_runtime
        uid, gid = os.getuid(), os.getgid()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            runtime = root / "run/user" / str(uid)
            runtime.mkdir(parents=True, mode=0o700)
            runtime.chmod(0o700)
            prepare(uid, gid, host_root=root)
            libnetwork = runtime / "docker/libnetwork"
            self.assertEqual(libnetwork.stat().st_mode & 0o7777, 0o700)
            (runtime / "docker").chmod(0o1700)
            prepare(uid, gid, host_root=root)
            self.assertEqual((runtime / "docker").stat().st_mode & 0o7777, 0o1700)
            libnetwork.chmod(0o600)
            with self.assertRaisesRegex(ValueError, "^deployment_runtime_directory_failed$"):
                prepare(uid, gid, host_root=root)
            self.assertEqual(libnetwork.stat().st_mode & 0o7777, 0o600)
            libnetwork.chmod(0o700)
            libnetwork.rmdir()
            (runtime / "docker").rmdir()
            prepare(uid, gid, host_root=root)
            self.assertEqual(libnetwork.stat().st_mode & 0o7777, 0o700)

    def test_directory_symlinks_wrong_identity_and_unsafe_existing_paths_are_rejected(self):
        if self.unprivileged_fixture():
            return
        prepare = importlib.import_module("host_runtime").prepare_runtime
        uid, gid = os.getuid(), os.getgid()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            runtime = root / "run/user" / str(uid)
            runtime.mkdir(parents=True, mode=0o700)
            other = root / "other"
            other.mkdir(mode=0o700)
            docker = runtime / "docker"
            docker.symlink_to(other, target_is_directory=True)
            with self.assertRaises(ValueError):
                prepare(uid, gid, host_root=root)
            self.assertEqual(list(other.iterdir()), [])
            docker.unlink()
            docker.mkdir(mode=0o755)
            with self.assertRaises(ValueError):
                prepare(uid, gid, host_root=root)
            self.assertEqual(docker.stat().st_mode & 0o7777, 0o755)
            docker.chmod(0o700)
            (docker / "libnetwork").symlink_to(other, target_is_directory=True)
            with self.assertRaises(ValueError):
                prepare(uid, gid, host_root=root)
            self.assertEqual(list(other.iterdir()), [])
            with self.assertRaises(ValueError):
                prepare(uid + 1, gid, host_root=root)
            with self.assertRaises(ValueError):
                prepare(uid, gid + 1, host_root=root)


if __name__ == "__main__":
    unittest.main()
