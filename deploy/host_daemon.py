"""Trusted user-service launch chain; does not ptrace the privileged RootlessKit parent."""

from __future__ import annotations

import os
import re
from pathlib import Path

from host_io import trusted
from release_store import DeploymentError


def daemon_path(config):
    return ":".join(
        dict.fromkeys(
            [str(Path(config.rootlesskit.path).parent), "/usr/bin", "/usr/sbin", "/bin", "/sbin"]
        )
    )


def daemon_argv(config):
    return [
        "/usr/bin/env",
        "-i",
        "HOME=" + str(config.state_root / "daemon-home"),
        "PATH=" + daemon_path(config),
        "XDG_RUNTIME_DIR=" + str(config.runtime_root.parent),
        "NOTIFY_SOCKET=${NOTIFY_SOCKET}",
        "/usr/bin/dockerd-rootless.sh",
        "--host=unix://" + str(config.socket),
        "--config-file=/etc/devhot-site/daemon.json",
    ]


def daemon_unit(config):
    return f"""[Unit]
Description=Devhot dedicated Rootless Docker
ConditionUser=devhot-site

[Service]
Type=notify
NotifyAccess=all
WorkingDirectory=/
ExecStart={" ".join(daemon_argv(config))}
Delegate=yes
KillMode=mixed
TimeoutStartSec=120
TimeoutStopSec=120
Restart=always
RestartSec=5
LimitNOFILE=infinity
LimitNPROC=infinity
TasksMax=infinity
UMask=0077

[Install]
WantedBy=default.target
"""


def effective_start_matches(config, value):
    match = re.match(r"^\{ path=/usr/bin/env ; argv\[\]=(.*?) ; ignore_errors=no ; ", value)
    if match is None or value.count("{ path=") != 1:
        return False
    argv = match[1].split()
    expected = daemon_argv(config)
    if len(argv) != len(expected):
        return False
    # systemd versions may show the notification socket expanded or literal.
    if not argv[5].startswith("NOTIFY_SOCKET="):
        return False
    argv[5] = expected[5]
    return argv == expected


def process_identity(proc):
    status = dict(
        line.split(":", 1) for line in (proc / "status").read_text().splitlines() if ":" in line
    )
    uids = [int(value) for value in status["Uid"].split()]
    if len(uids) != 4 or len(set(uids)) != 1:
        raise DeploymentError("deployment_process_identity_failed")
    # starttime is field 22; the comm field can itself contain spaces/parentheses.
    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    return {
        "uid": uids[0],
        "cap_effective": int(status["CapEff"].strip(), 16),
        "cap_permitted": int(status["CapPrm"].strip(), 16),
        "start_ticks": int(fields[19]),
        "argv": (proc / "cmdline").read_bytes().rstrip(b"\0").decode().split("\0"),
    }


def trusted_launch_files(config):
    rootlesskit = Path(config.rootlesskit.path)
    if not trusted(rootlesskit, executable=True):
        return False
    for directory in daemon_path(config).split(":"):
        path = Path(directory)
        if not trusted(path.resolve()):
            return False
        # The official launcher prefers this alternative name before rootlesskit.
        if os.path.lexists(path / "docker-rootlesskit"):
            return False
    return all(
        trusted(path, executable=True)
        for path in (
            Path("/usr/bin/env"),
            Path("/usr/bin/dockerd-rootless.sh"),
            Path("/bin/sh").resolve(),
        )
    )


def process_children(proc):
    children = set()
    for task in (proc / "task").iterdir():
        children.update(int(item) for item in (task / "children").read_text().split())
    return children


def subordinate_ranges_safe(ranges, identity):
    """Validate every grant, including extra ranges unused by the current daemon."""
    try:
        if not ranges or sum(count for _, count in ranges) < 65536:
            return False
        end = 0
        for start, count in sorted(ranges):
            if (
                type(start) is not int
                or type(count) is not int
                or start <= 0
                or count <= 0
                or start + count > 2**32 - 1
                or start < end
                or start <= identity < start + count
            ):
                return False
            end = start + count
        return True
    except (ValueError, TypeError):
        return False


def namespace_map_matches(text, identity, ranges):
    try:
        if not subordinate_ranges_safe(ranges, identity):
            return False
        rows = [tuple(map(int, line.split())) for line in text.splitlines()]
        if (
            any(len(row) != 3 for row in rows)
            or (0, identity, 1) not in rows
            or len(set(rows)) != len(rows)
        ):
            return False
        subordinate = [row for row in rows if row != (0, identity, 1)]
        if sum(count for _, _, count in subordinate) < 65536:
            return False
        end = 1
        for inside, outside, count in sorted(subordinate):
            if (
                inside != end
                or count < 1
                or inside + count > 2**32 - 1
                or not any(
                    start <= outside and outside + count <= start + size for start, size in ranges
                )
            ):
                return False
            end = inside + count
        return True
    except (ValueError, TypeError):
        return False
