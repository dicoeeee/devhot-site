"""Real Unix socket identity, permissions and RootlessKit-style copy-up aliases."""

import os
import pathlib
import socket
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))
from host_sockets import protected_ipc_socket


class HostSocketTests(unittest.TestCase):
    def test_ipc_requires_same_protected_socket_across_copy_up(self):
        with tempfile.TemporaryDirectory(prefix="i84-", dir="/tmp") as directory:
            root = pathlib.Path(directory)
            host, child = root / "host", root / "child"
            logical = "/run/user/1/docker/libnetwork/0123456789ab.sock"
            target = host / logical.lstrip("/")
            target.parent.mkdir(parents=True)
            (child / "run").mkdir(parents=True)
            # A relative /run/user alias models RootlessKit copy-up without mount privileges.
            (child / "run/.ro").symlink_to(host / "run", target_is_directory=True)
            (child / "run/user").symlink_to(".ro/user", target_is_directory=True)
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(target))
                listener.listen()
                target.chmod(0o600)
                os.chown(target, -1, os.getgid())

                def check():
                    return protected_ipc_socket(
                        child, logical, os.getuid(), os.getgid(), host_root=host
                    )

                self.assertTrue(check())
                self.assertFalse(
                    protected_ipc_socket(
                        child, logical, os.getuid() + 1, os.getgid(), host_root=host
                    )
                )
                target.chmod(0o660)
                self.assertFalse(check())
                target.chmod(0o600)
                target.parent.chmod(0o777)
                self.assertFalse(check())
                target.parent.chmod(0o755)
                self.assertTrue(check())
                (child / "run/user").unlink()
                (child / "run/user").mkdir()
                self.assertFalse(check())
                replacement = child / logical.lstrip("/")
                replacement.parent.mkdir(parents=True)
                with socket.socket(socket.AF_UNIX) as different:
                    different.bind(str(replacement))
                    different.listen()
                    replacement.chmod(0o600)
                    os.chown(replacement, -1, os.getgid())
                    self.assertNotEqual(replacement.stat().st_ino, target.stat().st_ino)
                    self.assertFalse(check())
