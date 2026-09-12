"""Strict private deployment records, atomic writes and one nonblocking lock."""

from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from release_store import DeploymentError, checked_sha

SHA_FIELDS = (
    "last_observed_sha",
    "last_build_success_sha",
    "last_success_sha",
    "current_sha",
    "previous_sha",
    "failed_sha",
    "paused_sha",
)
FACT_TIMES = {
    "last_observed_sha": "last_observed_at",
    "last_build_success_sha": "last_build_success_at",
    "last_success_sha": "last_success_at",
    "previous_sha": "previous_success_at",
    "failed_sha": "failure_recorded_at",
    "paused_sha": "paused_at",
}
FAILURE_PHASES = {
    "prepare",
    "input",
    "dependencies",
    "build",
    "artifact",
    "switch",
    "health",
    "state",
    "interrupted",
    "cleanup",
}
STATES = {
    "idle",
    "preparing",
    "building",
    "switching",
    "rolling_back",
    "recovering",
    "recovery_required",
}
ROLLBACK_RESULTS = {None, "not_needed", "passed", "failed", "no_previous", "restored_before"}
RESULT_FIELDS = {
    "status",
    "sha",
    "previous_sha",
    "current_sha",
    "phase",
    "code",
    "rollback_result",
    "prepare_attempts",
    "recorded_at",
}
RESULT_PHASES = FAILURE_PHASES | {"check", "complete", "rollback", "rollback_health", "recovery"}
RESULT_CODES = {
    None,
    "deployment_unchanged",
    "deployment_failed_sha",
    "deployment_paused_sha",
    "deployment_rollback_health_failed",
    "deployment_recovery_complete",
    "deployment_recovery_failed",
} | {"deployment_" + phase + "_failed" for phase in FAILURE_PHASES}
PENDING_FIELDS = {
    "action",
    "sha",
    "before_sha",
    "new_version",
    "candidate_owned",
    "fingerprints",
    "failure_phase",
}


def initial_state() -> dict:
    return {
        "schemaVersion": 1,
        **{field: None for field in SHA_FIELDS},
        **{field: None for field in FACT_TIMES.values()},
        "failed_phase": None,
        "rollback_result": None,
        "phase": "idle",
        "updated_at": None,
        "prepare_attempts": 0,
        "last_result": None,
        "pending": None,
        "versions": {},
        "retired": {},
        "rollback_recorded_at": None,
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def unique_object(pairs) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def valid_timestamp(value) -> None:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value)
        is None
    ):
        raise ValueError
    datetime.fromisoformat(value.replace("Z", "+00:00"))


def valid_sha(value, *, optional: bool = False) -> None:
    if value is None and optional:
        return
    if not isinstance(value, str):
        raise ValueError
    checked_sha(value)


def valid_fingerprints(value) -> None:
    if not isinstance(value, dict) or set(value) != {"exact", "semantic"}:
        raise ValueError
    if any(
        not isinstance(item, str) or re.fullmatch(r"[0-9a-f]{64}", item) is None
        for item in value.values()
    ):
        raise ValueError


def validate_state(state: dict) -> None:
    if not isinstance(state, dict) or set(state) != set(initial_state()):
        raise ValueError
    if type(state["schemaVersion"]) is not int or state["schemaVersion"] != 1:
        raise ValueError
    for field in SHA_FIELDS:
        valid_sha(state[field], optional=True)
    for fact, timestamp_field in FACT_TIMES.items():
        if state[fact] is None:
            if state[timestamp_field] is not None:
                raise ValueError
        else:
            valid_timestamp(state[timestamp_field])
    if not isinstance(state["versions"], dict):
        raise ValueError
    for sha, fingerprints in state["versions"].items():
        valid_sha(sha)
        valid_fingerprints(fingerprints)
    if not isinstance(state["retired"], dict) or set(state["retired"]) & set(state["versions"]):
        raise ValueError
    for sha, fingerprints in state["retired"].items():
        valid_sha(sha)
        valid_fingerprints(fingerprints)
    for field in ("last_success_sha", "previous_sha", "paused_sha"):
        if state[field] is not None and state[field] not in state["versions"]:
            raise ValueError
    if state["failed_phase"] not in FAILURE_PHASES | {None} or (state["failed_sha"] is None) != (
        state["failed_phase"] is None
    ):
        raise ValueError
    if state["phase"] not in STATES or state["rollback_result"] not in ROLLBACK_RESULTS:
        raise ValueError
    if state["rollback_result"] is None:
        if state["rollback_recorded_at"] is not None:
            raise ValueError
    else:
        valid_timestamp(state["rollback_recorded_at"])
    if type(state["prepare_attempts"]) is not int or not 0 <= state["prepare_attempts"] <= 3:
        raise ValueError
    valid_timestamp(state["updated_at"])
    result = state["last_result"]
    if result is not None:
        if not isinstance(result, dict) or set(result) != RESULT_FIELDS:
            raise ValueError
        valid_sha(result["sha"])
        valid_sha(result["previous_sha"], optional=True)
        valid_sha(result["current_sha"], optional=True)
        valid_timestamp(result["recorded_at"])
        if (
            result["status"] not in {"success", "failed", "skipped"}
            or result["phase"] not in RESULT_PHASES
            or result["code"] not in RESULT_CODES
            or result["rollback_result"] not in ROLLBACK_RESULTS
        ):
            raise ValueError
        if type(result["prepare_attempts"]) is not int or not 0 <= result["prepare_attempts"] <= 3:
            raise ValueError
    pending = state["pending"]
    if pending is None:
        if state["phase"] != "idle" or state["current_sha"] != state["last_success_sha"]:
            raise ValueError
        return
    if not isinstance(pending, dict) or set(pending) != PENDING_FIELDS:
        raise ValueError
    valid_sha(pending["sha"])
    valid_sha(pending["before_sha"], optional=True)
    if pending["action"] not in {"deploy", "rollback"} or pending["sha"] == pending["before_sha"]:
        raise ValueError
    if pending["before_sha"] != state["last_success_sha"] or state["current_sha"] not in {
        pending["before_sha"],
        pending["sha"],
    }:
        raise ValueError
    if type(pending["new_version"]) is not bool or type(pending["candidate_owned"]) is not bool:
        raise ValueError
    if pending["new_version"] == (pending["sha"] in state["versions"]):
        raise ValueError
    if pending["failure_phase"] not in FAILURE_PHASES | {"rollback_health", None}:
        raise ValueError
    if pending["fingerprints"] is not None:
        valid_fingerprints(pending["fingerprints"])
        if not pending["new_version"] and pending["fingerprints"] != state["versions"].get(
            pending["sha"]
        ):
            raise ValueError
    if state["phase"] == "idle" or (
        state["phase"] in {"switching", "rolling_back"} and pending["fingerprints"] is None
    ):
        raise ValueError
    if state["phase"] in {"preparing", "building"} and pending["fingerprints"] is not None:
        raise ValueError
    if pending["action"] == "rollback" and (
        pending["new_version"]
        or pending["candidate_owned"]
        or pending["sha"] != state["previous_sha"]
    ):
        raise ValueError


class DeploymentState:
    def __init__(self, directory: Path, runtime: Path, *, forbidden: tuple[Path, ...]):
        for path in (directory, runtime):
            if path.is_symlink():
                raise DeploymentError("deployment_unsafe_state_directory")
        self.directory = directory.absolute().parent.resolve() / directory.name
        self.runtime = runtime.absolute().parent.resolve() / runtime.name
        for path in (self.directory, self.runtime):
            if any(path.is_relative_to(root.resolve()) for root in forbidden):
                raise DeploymentError("deployment_private_state_inside_site")
        if self.directory.is_relative_to(self.runtime) or self.runtime.is_relative_to(
            self.directory
        ):
            raise DeploymentError("deployment_state_runtime_overlap")
        self.file = self.directory / "state.json"
        self.lock_file = self.runtime / "deployment.lock"
        self.owner = None
        self.writable = False

    @staticmethod
    def private_directory(path: Path, *, create: bool) -> None:
        if create and not path.is_symlink():
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = path.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise DeploymentError("deployment_unsafe_state_directory")

    @staticmethod
    def private_file(descriptor: int) -> None:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
            or metadata.st_size > 65536
        ):
            raise DeploymentError("deployment_unsafe_state_file")

    def require_lock(self, *, write: bool = False) -> None:
        if self.owner != (os.getpid(), threading.get_ident()) or (write and not self.writable):
            raise DeploymentError("deployment_lock_required")

    @contextmanager
    def locked(self, *, write: bool):
        # One host command can hold the lock across ref lookup and nested core
        # operations. Only the same object/thread/process may reuse ownership.
        if self.owner == (os.getpid(), threading.get_ident()):
            self.require_lock(write=write)
            yield
            return
        self.private_directory(self.directory, create=write)
        self.private_directory(self.runtime, create=write)
        descriptor = os.open(
            self.lock_file,
            os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_CREAT if write else 0),
            0o600,
        )
        try:
            self.private_file(descriptor)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeploymentError("deployment_busy") from None
            self.owner, self.writable = (os.getpid(), threading.get_ident()), write
            try:
                yield
            finally:
                self.owner, self.writable = None, False
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    def read(self) -> dict:
        self.require_lock()
        if self.file.is_symlink():
            raise DeploymentError("deployment_state_corrupt")
        if not self.file.exists():
            return initial_state()
        try:
            descriptor = os.open(self.file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor) as stream:
                self.private_file(stream.fileno())
                state = json.load(stream, object_pairs_hook=unique_object)
            validate_state(state)
            return state
        except (OSError, ValueError, TypeError, RecursionError):
            raise DeploymentError("deployment_state_corrupt") from None

    def write(self, state: dict) -> None:
        self.require_lock(write=True)
        state["updated_at"] = utc_now()
        if isinstance(state["last_result"], dict) and "recorded_at" not in state["last_result"]:
            state["last_result"]["recorded_at"] = state["updated_at"]
        try:
            validate_state(state)
        except (ValueError, TypeError):
            raise DeploymentError("deployment_state_corrupt") from None
        temporary = self.directory / (".state-" + uuid.uuid4().hex)
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(state, stream, ensure_ascii=False, allow_nan=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
        except OSError:
            raise DeploymentError("deployment_state_write_failed") from None
        finally:
            if temporary.exists():
                temporary.unlink()
