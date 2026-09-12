"""Distinguish the fixed Docker API from its necessary private libnetwork IPC."""

from __future__ import annotations

import re
import stat
from pathlib import Path


def protected_ipc_socket(
    root: Path, path: str, uid: int, gid: int, *, host_root: Path = Path("/")
) -> bool:
    """Verify the host socket and its identity through RootlessKit's /run copy-up."""
    try:
        parts = Path(path).parts
        if not parts or parts[0] != "/" or ".." in parts:
            return False
        parent = host_root
        for component in parts[1:-1]:
            parent = parent / component
            value = parent.lstat()
            if (
                not stat.S_ISDIR(value.st_mode)
                or value.st_uid not in (0, uid)
                or value.st_mode & 0o022
            ):
                return False
        value = (parent / parts[-1]).lstat()
        observed = (root / path.lstrip("/")).stat()

        def identity(item):
            return (item.st_dev, item.st_ino, item.st_uid, item.st_gid, item.st_mode)

        return (
            stat.S_ISSOCK(value.st_mode)
            and value.st_uid == uid
            and value.st_gid == gid
            and stat.S_IMODE(value.st_mode) == 0o600
            and identity(value) == identity(observed)
            and identity(value) == identity((parent / parts[-1]).lstat())
        )
    except (OSError, ValueError):
        return False


def socket_policy(
    owned: set[str],
    tcp_tables: list[str],
    unix_table: str,
    socket: str,
    *,
    internal_socket_check=None,
) -> bool:
    if not owned or len(tcp_tables) != 2:
        return False
    for table in tcp_tables:
        lines = table.splitlines()
        if not lines or "local_address" not in lines[0]:
            return False
        for line in lines[1:]:
            fields = line.split()
            if len(fields) < 10:
                return False
            if fields[9] in owned and fields[3] == "0A":
                return False
    lines = unix_table.splitlines()
    if not lines or not lines[0].startswith("Num"):
        return False
    listeners = []
    for line in lines[1:]:
        fields = line.split()
        if len(fields) < 7:
            return False
        if fields[6] in owned and fields[3] == "00010000":
            if len(fields) != 8 or fields[4] != "0001":
                return False
            listeners.append(fields[7])
    if listeners.count(socket) != 1:
        return False
    internal = [path for path in listeners if path != socket]
    pattern = re.escape(str(Path(socket).parent / "docker/libnetwork")) + r"/[0-9a-f]{12}\.sock"
    return len(internal) <= 1 and all(
        re.fullmatch(pattern, path) is not None
        and internal_socket_check is not None
        and internal_socket_check(path) is True
        for path in internal
    )
