"""One host operation owns the core lock from ref lookup through final projection."""

from __future__ import annotations

import json
import re
import sys
import time

from deployment_controller import PreparationUnavailable
from release_store import DeploymentError, checked_sha


class Events:
    def __init__(self, stream=None):
        self.stream = stream if stream is not None else sys.stdout
        self.started = time.monotonic()
        self.write_failed = False

    def __call__(self, stage, sha, result, code=None):
        if sha is not None:
            checked_sha(sha)
        if not all(
            isinstance(value, str) and re.fullmatch("[a-z_]+", value) for value in (stage, result)
        ):
            raise DeploymentError("deployment_invalid_event")
        if code is not None and re.fullmatch("deployment_[a-z_]+", code) is None:
            code = "deployment_operation_failed"
        row = dict(
            stage=stage,
            sha=sha,
            result=result,
            duration_ms=round((time.monotonic() - self.started) * 1000),
            code=code,
        )
        try:
            self.stream.write(json.dumps(row) + "\n")
            self.stream.flush()
        except OSError:
            self.write_failed = True  # Never interrupt an atomic compensation.


class HostCommands:
    def __init__(self, controller, docker, builder, emit, resolve):
        self.controller, self.docker, self.builder = controller, docker, builder
        self.emit, self.resolve = emit, resolve

    def execute(self, command: str, sha: str | None = None) -> dict:
        if command in ("retry", "rollback"):
            checked_sha(sha)
        if command == "status":
            # Core status handles the virgin installation without creating a lock.
            result = self.controller.status()
            if result["state"]["current_sha"] is not None:
                with self.controller.locked(create=False):
                    result = self.controller.status()
                    self.docker.check_nginx()
                    if not self.controller.check_health(result["state"]["current_sha"]):
                        raise DeploymentError("deployment_status_service_mismatch")
            return result
        if command not in ("check-main", "retry", "rollback", "recover", "cleanup", "serve"):
            raise DeploymentError("deployment_invalid_command")
        with self.controller.locked(create=True):
            self.emit("check", sha, "started")
            if command == "serve":
                self.controller.store.initialize()
                return self.docker.serve()
            self.docker.check_nginx()
            try:
                if command == "check-main":
                    for used in range(3):
                        try:
                            sha = self.resolve()
                            break
                        except PreparationUnavailable:
                            self.emit("fetch", None, "failed", "deployment_prepare_failed")
                            if used == 2:
                                return dict(
                                    status="failed",
                                    phase="prepare",
                                    code="deployment_prepare_failed",
                                    prepare_attempts=3,
                                )
                            time.sleep(0.1 * (used + 1))
                    result = self.controller.deploy(sha, preparation_attempts_used=used)
                elif command == "retry":
                    result = self.controller.deploy(sha, retry=True)
                elif command == "rollback":
                    result = self.controller.rollback(sha)
                elif command == "recover":
                    self.builder.recover_builders()
                    result = self.controller.recover()
                else:
                    result = self.controller.cleanup()
                self.controller.publish_status()
                self.emit(
                    result.get("phase", command),
                    result.get("sha", sha),
                    result["status"],
                    result.get("code"),
                )
                return result
            finally:
                self.builder.dispose()
