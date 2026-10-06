"""Cold-start directory preparation on real temporary files, without repair."""

import importlib
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))


class HostRuntimeTests(unittest.TestCase):
    def test_each_cold_start_prepares_searchable_private_libnetwork_without_chmod(self):
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
