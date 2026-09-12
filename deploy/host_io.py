"""Trusted paths and bounded subprocesses; never inherit client credentials."""

from __future__ import annotations

import ctypes
import json
import os
import selectors
import signal
import stat
import subprocess
import time
from contextlib import suppress
from pathlib import Path

from deployment_state import unique_object
from release_store import DeploymentError


def metadata(path: Path) -> dict:
    value = path.lstat()
    kind = (
        "directory"
        if stat.S_ISDIR(value.st_mode)
        else "file"
        if stat.S_ISREG(value.st_mode)
        else "socket"
        if stat.S_ISSOCK(value.st_mode)
        else "other"
    )
    return dict(
        uid=value.st_uid,
        gid=value.st_gid,
        mode=stat.S_IMODE(value.st_mode),
        device=value.st_dev,
        inode=value.st_ino,
        kind=kind,
        canonical=path.is_absolute() and path.resolve() == path,
    )


def trusted(path: Path, *, executable: bool = False) -> bool:
    try:
        for item in (path, *path.parents):
            value = item.lstat()
            if value.st_uid != 0 or value.st_mode & 0o022 or stat.S_ISLNK(value.st_mode):
                return False
        value = path.stat()
        return not executable or (stat.S_ISREG(value.st_mode) and bool(value.st_mode & 0o111))
    except OSError:
        return False


def read_root_json(path: Path, group: int) -> dict:
    try:
        if not trusted(path):
            raise ValueError
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor) as stream:
            value = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(value.st_mode)
                or value.st_uid != 0
                or value.st_gid != group
                or stat.S_IMODE(value.st_mode) != 0o640
                or value.st_nlink != 1
                or value.st_size > 65536
            ):
                raise ValueError
            result = json.load(stream, object_pairs_hook=unique_object)
            if not isinstance(result, dict):
                raise ValueError
            return result
    except (OSError, ValueError, TypeError, RecursionError):
        raise DeploymentError("deployment_untrusted_configuration") from None


def command_environment(uid: int) -> dict[str, str]:
    return {
        "PATH": "/usr/bin:/usr/sbin:/bin:/sbin",
        "LANG": "C",
        "LC_ALL": "C",
        "HOME": "/nonexistent",
        "DOCKER_CONFIG": "/etc/devhot-site/docker-client",
        "XDG_RUNTIME_DIR": "/run/user/" + str(uid),
        "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/" + str(uid) + "/bus",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_SSH_COMMAND": "/usr/bin/false",
    }


def run(
    arguments: list[str],
    environment: dict,
    *,
    timeout: float = 30,
    check: bool = True,
    limit: int = 8 * 1024 * 1024,
    binary: bool = False,
) -> subprocess.CompletedProcess:
    executable = Path(arguments[0]).resolve()
    if not trusted(executable, executable=True):
        raise DeploymentError("deployment_untrusted_executable")
    process = None
    selector = selectors.DefaultSelector()
    buffers = [bytearray(), bytearray()]
    started = time.monotonic()
    try:
        process = subprocess.Popen(
            [str(executable), *arguments[1:]],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            cwd="/",
        )
        for index, stream in enumerate((process.stdout, process.stderr)):
            selector.register(stream, selectors.EVENT_READ, index)
        while selector.get_map():
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise DeploymentError("deployment_command_timeout")
            for key, _ in selector.select(min(remaining, 1)):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                buffers[key.data].extend(data)
                if sum(map(len, buffers)) > limit:
                    raise DeploymentError("deployment_command_output_limit")
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise DeploymentError("deployment_command_timeout")
        process.wait(timeout=remaining)
    except BaseException as error:
        if process is not None:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        if isinstance(error, subprocess.TimeoutExpired):
            raise DeploymentError("deployment_command_timeout") from None
        if isinstance(error, OSError):
            raise DeploymentError("deployment_command_failed") from None
        raise
    finally:
        selector.close()
        if process is not None:
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
    if check and process.returncode:
        raise DeploymentError("deployment_command_failed")
    streams = [
        bytes(data) if binary else data.decode("utf-8", errors="replace") for data in buffers
    ]
    return subprocess.CompletedProcess(arguments, process.returncode, *streams)


def enforce_no_new_privileges():
    if not Path("/proc/self/status").exists():
        raise DeploymentError("deployment_no_new_privileges_failed")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, *([ctypes.c_ulong] * 4)]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(39, 0, 0, 0, 0) != 1:
        raise DeploymentError("deployment_no_new_privileges_failed")
    return True


def secure_directory_ancestors(path: Path, uid: int) -> bool:
    try:
        return all(
            stat.S_ISDIR(value.st_mode) and value.st_uid in (0, uid) and not value.st_mode & 0o022
            for value in (item.lstat() for item in (path, *path.parents))
        )
    except OSError:
        return False
