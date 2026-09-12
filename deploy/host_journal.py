"""Connect manual commands to journal streams without changing their event protocol."""

from __future__ import annotations

import contextlib
import os
import select
import signal
import socket
import stat
import struct
import subprocess
from pathlib import Path

from host_commands import Events
from host_io import command_environment, metadata, trusted

JOURNAL_IO_ERROR = 74
JOURNAL_SOCKET = Path("/run/systemd/journal/stdout")


def is_journal_stream(descriptor: int) -> bool:
    try:
        endpoint = metadata(JOURNAL_SOCKET)
        if (
            not trusted(JOURNAL_SOCKET.parent)
            or endpoint["kind"] != "socket"
            or endpoint["uid"] != 0
            or endpoint["canonical"] is not True
            or not stat.S_ISSOCK(os.fstat(descriptor).st_mode)
        ):
            return False
        with socket.fromfd(descriptor, socket.AF_UNIX, socket.SOCK_STREAM) as stream:
            credentials = stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _, uid, _ = struct.unpack("3i", credentials)
            return (
                uid == 0
                and stream.getpeername() == str(JOURNAL_SOCKET)
                and stream.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM
            )
    except (OSError, ValueError, AttributeError, KeyError):
        return False


def journal_streams_ready() -> bool:
    return is_journal_stream(1) and is_journal_stream(2)


def finish_events(events: Events, code: int) -> int:
    if not events.write_failed:
        return code
    # Only after the operation/compensation finishes. Avoid a second failed flush
    # at interpreter shutdown replacing the explicit journal-I/O exit status.
    with contextlib.suppress(OSError):
        events.stream.close()
    return JOURNAL_IO_ERROR


def run_in_journal(script: Path, arguments: list[str]) -> int:
    worker = script.with_name("host_journal_worker.py")
    executables = (Path("/usr/bin/systemd-cat"), Path("/usr/bin/python3"))
    if (
        not trusted(script)
        or not trusted(worker)
        or not all(trusted(path.resolve(), executable=True) for path in executables)
    ):
        Events()("journal", None, "failed", "deployment_journal_launcher_untrusted")
        return 1
    parent, child = socket.socketpair()
    process = None
    try:
        # Two-way admission bounds startup; the worker cannot mutate before GO.
        # Native systemd-cat startup diagnostics are discarded, not captured unboundedly.
        process = subprocess.Popen(
            [
                str(executables[0]),
                "--identifier=devhot-site",
                "--priority=info",
                "--stderr-priority=err",
                str(executables[1]),
                "-E",
                "-s",
                "-B",
                str(worker),
                str(child.fileno()),
                *arguments,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(child.fileno(),),
            start_new_session=True,
            env=command_environment(os.getuid()),
        )
        child.close()
        parent.settimeout(5)
        if not select.select([parent], [], [], 5)[0] or parent.recv(1) != b"R":
            raise OSError("journal admission failed")
        parent.sendall(b"G")
        code = process.wait()
    except (OSError, subprocess.SubprocessError):
        Events()("journal", None, "failed", "deployment_journal_launch_failed")
        return 1
    except KeyboardInterrupt:
        if process is not None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGINT)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=35)
        return 130
    finally:
        parent.close()
        child.close()
        if process is not None and process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    code = code if code >= 0 else 128 - code
    if code == JOURNAL_IO_ERROR:
        Events()(
            "journal",
            None,
            "failed",
            "deployment_journal_write_failed",
        )
    return code


def accept_worker(descriptor: int) -> bool:
    if descriptor < 3 or not journal_streams_ready():
        return False
    try:
        with socket.socket(fileno=descriptor) as control:
            control.settimeout(5)
            credentials = control.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            pid, uid, _ = struct.unpack("3i", credentials)
            if pid != os.getppid() or uid != os.getuid():
                return False
            control.sendall(b"R")
            return control.recv(1) == b"G"
    except (OSError, ValueError):
        return False
