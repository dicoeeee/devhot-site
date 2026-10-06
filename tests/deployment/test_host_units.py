"""Installed unit identity through the standard Ubuntu directory alias."""

import importlib
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))


class HostUnitTests(unittest.TestCase):
    def test_standard_root_alias_requires_same_installed_file_and_safe_ancestors(self):
        matches = importlib.import_module("host_units").installed_unit_matches
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            installed = root / "etc/systemd/user/docker.service"
            installed.parent.mkdir(parents=True)
            installed.write_text("approved unit\n")
            alias = root / "etc/xdg/systemd/user"
            alias.parent.mkdir(parents=True)
            alias.symlink_to("../../systemd/user", target_is_directory=True)
            service = {"FragmentPath": "/etc/xdg/systemd/user/docker.service", "DropInPaths": ""}
            # Ownership is an OS observation; files, links, contents and inode changes are real.
            lstat, fstat = pathlib.Path.lstat, os.fstat
            unsafe_owner = set()

            def observed(path, *args, **kwargs):
                value = list(lstat(path, *args, **kwargs))
                value[4] = 1001 if path in unsafe_owner else 0
                if path in root.parents:
                    value[0] &= ~0o022
                return os.stat_result(value)

            def opened(fd):
                value = list(fstat(fd))
                value[4] = 0
                return os.stat_result(value)

            def check():
                return matches("docker.service", "approved unit\n", service, host_root=root)

            with patch.object(pathlib.Path, "lstat", observed), patch("os.fstat", opened):
                self.assertTrue(check())
                service["FragmentPath"] = "/etc/systemd/user/docker.service"
                self.assertTrue(check())
                service["FragmentPath"] = "/home/user/docker.service"
                self.assertFalse(check())
                service["FragmentPath"] = "/etc/xdg/systemd/user/docker.service"
                service["DropInPaths"] = "/etc/systemd/user/docker.service.d/extra.conf"
                self.assertFalse(check())
                service["DropInPaths"] = ""
                unsafe_owner.add(alias)
                self.assertFalse(check())
                unsafe_owner.clear()
                alias.parent.chmod(0o777)
                self.assertFalse(check())
                alias.parent.chmod(0o755)
                installed.write_text("modified unit\n")
                self.assertFalse(check())
                installed.write_text("approved unit\n")
                alias.unlink()
                alias.mkdir()
                (alias / "docker.service").write_text("approved unit\n")
                self.assertNotEqual(
                    installed.stat().st_ino, (alias / "docker.service").stat().st_ino
                )
                self.assertFalse(check())
                (alias / "docker.service").unlink()
                alias.rmdir()
                alias.symlink_to("../../other/user", target_is_directory=True)
                self.assertFalse(check())
                alias.unlink()
                intermediate = root / "etc/untrusted"
                intermediate.mkdir(mode=0o777)
                intermediate.chmod(0o777)
                (intermediate / "user").symlink_to("../systemd/user", target_is_directory=True)
                alias.symlink_to("../../untrusted/user", target_is_directory=True)
                self.assertEqual(alias.resolve(), installed.parent)
                self.assertFalse(check())
                alias.unlink()
                alias.symlink_to(installed.parent, target_is_directory=True)
                self.assertTrue(check())


if __name__ == "__main__":
    unittest.main()
