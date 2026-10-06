"""Prepare private IPC directories before dockerd, never repair existing modes."""

from __future__ import annotations

import argparse
import os
import stat
from contextlib import ExitStack
from pathlib import Path

from release_store import DeploymentError


def prepare_runtime(uid: int, gid: int, *, host_root: Path = Path("/")) -> None:
    try:
        if uid == 0 or (os.getuid(), os.getgid()) != (uid, gid):
            raise ValueError
        if not host_root.is_absolute() or host_root.resolve() != host_root:
            raise ValueError
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        with ExitStack() as stack:

            def opened(name, parent=None, modes=None):
                fd = os.open(name, flags, dir_fd=parent)
                stack.callback(os.close, fd)
                value = os.fstat(fd)
                named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                identity = lambda item: (
                    item.st_dev,
                    item.st_ino,
                    item.st_uid,
                    item.st_gid,
                    item.st_mode,
                )
                if (
                    identity(value) != identity(named)
                    or not stat.S_ISDIR(value.st_mode)
                    or value.st_uid not in (0, uid)
                    or value.st_mode & 0o022
                    or (
                        modes is not None
                        and (
                            (value.st_uid, value.st_gid) != (uid, gid)
                            or stat.S_IMODE(value.st_mode) not in modes
                        )
                    )
                ):
                    raise ValueError
                return fd

            parent = opened(host_root)
            parent = opened("run", parent)
            parent = opened("user", parent)
            parent = opened(str(uid), parent, (0o700,))
            for name, modes in (("docker", (0o700, 0o1700)), ("libnetwork", (0o700,))):
                try:
                    os.mkdir(name, 0o700, dir_fd=parent)
                except FileExistsError:
                    pass
                parent = opened(name, parent, modes)
    except (OSError, ValueError, RuntimeError):
        raise DeploymentError("deployment_runtime_directory_failed") from None


def main(argv=None):
    # Imports are delayed because host_config also renders host_daemon's unit.
    from host_commands import Events
    from host_config import parse_config
    from host_io import read_root_json

    parser = argparse.ArgumentParser(description="Prepare private daemon IPC before startup")
    parser.add_argument("--config", type=Path, default=Path("/etc/devhot-site/instance.json"))
    args = parser.parse_args(argv)
    events = Events()
    try:
        config = parse_config(read_root_json(args.config, os.getgid()))
        prepare_runtime(config.uid, config.gid)
        events("runtime_prepare", None, "success")
        return 0
    except (DeploymentError, OSError, ValueError, KeyError):
        events("runtime_prepare", None, "failed", "deployment_runtime_directory_failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
