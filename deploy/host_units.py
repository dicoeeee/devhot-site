"""Verify installed units without trusting arbitrary systemd path aliases."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from host_io import trusted


def installed_unit_matches(
    name: str, content: str, service: dict, *, host_root: Path = Path("/")
) -> bool:
    if name not in ("docker.service", "devhot-site.service", "devhot-site.timer"):
        return False
    installed = Path("/etc/systemd/user") / name
    alternative = Path("/etc/xdg/systemd/user") / name
    fragment = service.get("FragmentPath")
    if fragment not in (str(installed), str(alternative)) or service.get("DropInPaths") != "":
        return False
    expected = host_root / installed.relative_to("/")
    observed = host_root / Path(fragment).relative_to("/")

    def identity(value):
        return (
            value.st_dev,
            value.st_ino,
            value.st_uid,
            value.st_gid,
            value.st_mode,
            value.st_size,
            value.st_mtime_ns,
        )

    try:
        if not trusted(expected):
            return False
        if fragment == str(alternative):
            alias = observed.parent
            link = alias.lstat()
            if (
                not trusted(alias.parent)
                or link.st_uid != 0
                or not stat.S_ISLNK(link.st_mode)
                or os.readlink(alias) not in ("../../systemd/user", str(expected.parent))
                or alias.resolve(strict=True) != expected.parent
            ):
                return False
        before = expected.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > 65536:
            return False
        descriptor = os.open(expected, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            return (
                identity(before) == identity(opened) == identity(observed.lstat())
                and stream.read(65537) == content.encode()
                and identity(before) == identity(os.fstat(stream.fileno()))
                and identity(before) == identity(expected.lstat()) == identity(observed.lstat())
            )
    except (OSError, ValueError, RuntimeError):
        return False
