"""Serialize deployment commands and record independently observed release state."""

from __future__ import annotations

import os
import time
from copy import deepcopy
from pathlib import Path

from deployment_state import (
    FACT_TIMES,
    FAILURE_PHASES,
    SHA_FIELDS,
    DeploymentState,
    initial_state,
    utc_now,
)
from release_store import DeploymentError, artifact_fingerprints, checked_sha, validate_artifact


class DeploymentFailure(DeploymentError):
    def __init__(self, phase: str):
        if phase not in FAILURE_PHASES:
            raise DeploymentError("deployment_invalid_phase")
        self.phase = phase
        super().__init__("deployment_" + phase + "_failed")


class PreparationUnavailable(DeploymentError):
    def __init__(self):
        super().__init__("deployment_preparation_unavailable")


class DeploymentController:
    def __init__(self, store, state_dir: Path, runtime_dir: Path, *, prepare, build, health):
        self.store = store
        self.persistence = DeploymentState(state_dir, runtime_dir, forbidden=store.state_exclusions)
        self.state_dir, self.runtime_dir = self.persistence.directory, self.persistence.runtime
        self.state_file, self.lock_file = self.persistence.file, self.persistence.lock_file
        self.prepare, self.build, self.health = prepare, build, health

    def locked(self, *, create: bool):
        return self.persistence.locked(write=create)

    def read_state(self, *, recover_owned_candidate: bool = False) -> dict:
        try:
            self.store.check_layout()
            state = self.persistence.read()
            for version, fingerprints in state["versions"].items():
                if self.store.version_fingerprints(version) != fingerprints:
                    raise ValueError
            pending = state["pending"]
            repairing_new = bool(recover_owned_candidate and pending and pending["new_version"])
            actual = self.store.current_target_sha() if repairing_new else self.store.current_sha()
            if pending is None:
                if state["current_sha"] != actual:
                    raise ValueError
            else:
                allowed = {pending["before_sha"]}
                if pending["fingerprints"] is not None:
                    allowed.add(pending["sha"])
                if actual not in allowed:
                    raise ValueError
                if (
                    actual == pending["sha"]
                    and not repairing_new
                    and self.store.version_fingerprints(actual) != pending["fingerprints"]
                ):
                    raise ValueError
            return state
        except (OSError, ValueError, TypeError):
            raise DeploymentError("deployment_state_corrupt") from None

    def save_state(self, state: dict) -> None:
        self.persistence.write(state)

    @staticmethod
    def require_idle(state: dict) -> None:
        if state["pending"] is not None:
            raise DeploymentError("deployment_recovery_required")

    def fail_transition(self, state: dict, phase: str) -> dict:
        """Compensate a captured transition even when recording its failure fails."""
        pending = state["pending"]
        sha, before = pending["sha"], pending["before_sha"]
        pending["failure_phase"] = phase
        state["phase"] = "recovering"
        try:
            self.save_state(state)
        except DeploymentError as error:
            if str(error) != "deployment_state_write_failed":
                raise
        try:
            self.store.restore(before)
            restored = before is None or self.check_health(before)
        except Exception:
            restored = False
        rollback = (
            "failed"
            if not restored
            else "no_previous"
            if before is None
            else "restored_before"
            if pending["action"] == "rollback"
            else "passed"
        )
        if pending["action"] == "deploy":
            state.update(failed_sha=sha, failed_phase=phase, failure_recorded_at=utc_now())
        cleaned = restored
        if restored:
            try:
                if pending["candidate_owned"]:
                    self.store.discard_candidate(sha)
                if pending["new_version"]:
                    self.store.discard_version(sha)
            except Exception:
                cleaned = False
        state.update(
            current_sha=self.store.current_sha(),
            rollback_result=rollback,
            rollback_recorded_at=utc_now(),
            phase="idle" if restored and cleaned else "recovery_required",
        )
        if restored and cleaned:
            state["pending"] = None
        result_phase = "cleanup" if restored and not cleaned else phase
        result = {
            "status": "failed",
            "sha": sha,
            "previous_sha": before,
            "current_sha": state["current_sha"],
            "phase": result_phase,
            "code": "deployment_" + result_phase + "_failed",
            "rollback_result": rollback,
            "prepare_attempts": state["prepare_attempts"],
        }
        state["last_result"] = result
        self.save_state(state)
        return result

    def deploy(self, sha: str, *, retry: bool = False) -> dict:
        checked_sha(sha)
        with self.locked(create=True):
            state = self.read_state()
            self.require_idle(state)
            if state["retired"]:
                raise DeploymentError("deployment_cleanup_required")
            previous = state["current_sha"]
            if sha == previous:
                return self.skip(state, sha, "deployment_unchanged")
            if retry and sha not in (state["failed_sha"], state["paused_sha"]):
                raise DeploymentError("deployment_retry_not_allowed")
            if not retry and sha == state["failed_sha"]:
                return self.skip(state, sha, "deployment_failed_sha")
            if not retry and sha == state["paused_sha"]:
                return self.skip(state, sha, "deployment_paused_sha")
            state.update(last_observed_sha=sha, last_observed_at=utc_now(), phase="preparing")
            expected_candidate = self.store.candidates / sha
            if self.store.has_candidate(sha):
                raise DeploymentError("deployment_candidate_exists")
            protected = {state["last_success_sha"], state["previous_sha"], state["paused_sha"]}
            if sha in protected and not retry:
                raise DeploymentError("deployment_use_rollback")
            if (
                self.store.has_version(sha)
                and sha not in protected
                and not (retry and sha == state["failed_sha"])
            ):
                raise DeploymentError("deployment_unowned_version")
            if retry and sha == state["failed_sha"] and sha not in protected:
                self.store.discard_version(sha)
            state["pending"] = {
                "action": "deploy",
                "sha": sha,
                "before_sha": previous,
                "new_version": not self.store.has_version(sha),
                "candidate_owned": False,
                "fingerprints": None,
                "failure_phase": None,
            }
            phase = "prepare"
            reuse = False
            try:
                for attempt in range(1, 4):
                    try:
                        phase = "prepare"
                        state.update(phase="preparing", prepare_attempts=attempt)
                        self.save_state(state)
                        self.prepare(sha)
                        phase = "build"
                        state["phase"] = "building"
                        state["pending"]["candidate_owned"] = True
                        self.save_state(state)
                        candidate = self.build(sha)
                        phase = "artifact"
                        if candidate != expected_candidate:
                            raise DeploymentError("deployment_invalid_candidate")
                        validate_artifact(candidate, sha)
                        fresh = artifact_fingerprints(candidate, sha)
                        reuse = self.store.has_version(sha)
                        if reuse:
                            retained = self.store.version_fingerprints(sha)
                            if sha not in protected or fresh["semantic"] != retained["semantic"]:
                                raise DeploymentFailure("artifact")
                            self.store.discard_candidate(sha)
                            state["pending"]["candidate_owned"] = False
                        state["pending"]["fingerprints"] = retained if reuse else fresh
                        break
                    except PreparationUnavailable:
                        if phase != "prepare":
                            raise DeploymentFailure(phase) from None
                        self.store.discard_candidate(sha)
                        state["pending"]["candidate_owned"] = False
                        if attempt == 3:
                            raise DeploymentFailure("prepare") from None
                        time.sleep(0.1 * attempt)
            except Exception as error:
                failed_phase = (
                    error.phase
                    if isinstance(error, DeploymentFailure) and error.phase in FAILURE_PHASES
                    else phase
                )
                self.store.discard_candidate(sha)
                if failed_phase != "prepare":
                    state.update(
                        failed_sha=sha,
                        failure_recorded_at=utc_now(),
                        failed_phase=failed_phase,
                        rollback_result="not_needed",
                        rollback_recorded_at=utc_now(),
                    )
                state["phase"] = "idle"
                state["pending"] = None
                result = {
                    "status": "failed",
                    "sha": sha,
                    "previous_sha": previous,
                    "current_sha": self.store.current_sha(),
                    "phase": failed_phase,
                    "code": "deployment_" + failed_phase + "_failed",
                    "rollback_result": "not_needed",
                    "prepare_attempts": state["prepare_attempts"],
                }
                state["last_result"] = result
                self.save_state(state)
                return result
            state.update(
                last_build_success_sha=sha, last_build_success_at=utc_now(), phase="switching"
            )
            self.save_state(state)
            try:
                if reuse:
                    self.store.restore(sha)
                else:
                    self.store.activate(candidate, sha)
                self.store.discard_candidate(sha)
            except Exception:
                return self.fail_transition(state, "switch")
            if not self.check_health(sha):
                return self.fail_transition(state, "health")
            transition = deepcopy(state)
            state["versions"][sha] = state["pending"]["fingerprints"]
            for old in set(state["versions"]) - {sha, previous}:
                state["retired"][old] = state["versions"].pop(old)
            state.update(
                current_sha=sha,
                previous_sha=previous,
                previous_success_at=state["last_success_at"],
                last_success_sha=sha,
                last_success_at=utc_now(),
                failed_sha=None,
                failure_recorded_at=None,
                failed_phase=None,
                rollback_result=None,
                rollback_recorded_at=None,
                paused_sha=None,
                paused_at=None,
                phase="idle",
                pending=None,
            )
            result = {
                "status": "success",
                "sha": sha,
                "previous_sha": previous,
                "current_sha": sha,
                "phase": "complete",
                "code": None,
                "rollback_result": None,
                "prepare_attempts": state["prepare_attempts"],
            }
            state["last_result"] = result
            try:
                self.save_state(state)
            except DeploymentError as error:
                if str(error) != "deployment_state_write_failed":
                    raise
                return self.fail_transition(transition, "state")
            return self.cleanup_retired(state) if state["retired"] else result

    def rollback(self, sha: str) -> dict:
        checked_sha(sha)
        with self.locked(create=True):
            state = self.read_state()
            self.require_idle(state)
            previous = state["current_sha"]
            if previous is None or sha != state["previous_sha"] or sha == state["paused_sha"]:
                raise DeploymentError("deployment_rollback_not_allowed")
            state["pending"] = {
                "action": "rollback",
                "sha": sha,
                "before_sha": previous,
                "new_version": False,
                "candidate_owned": False,
                "fingerprints": self.store.version_fingerprints(sha),
                "failure_phase": None,
            }
            state.update(phase="rolling_back", prepare_attempts=0)
            self.save_state(state)
            try:
                self.store.restore(sha)
            except Exception:
                return self.fail_transition(state, "switch")
            if not self.check_health(sha):
                return self.fail_transition(state, "rollback_health")
            transition = deepcopy(state)
            state.update(
                current_sha=sha,
                previous_sha=previous,
                previous_success_at=state["last_success_at"],
                last_success_sha=sha,
                last_success_at=utc_now(),
                paused_sha=previous,
                paused_at=utc_now(),
                rollback_result="passed",
                rollback_recorded_at=utc_now(),
                phase="idle",
                pending=None,
            )
            result = {
                "status": "success",
                "sha": sha,
                "previous_sha": previous,
                "current_sha": sha,
                "phase": "rollback",
                "code": None,
                "rollback_result": "passed",
                "prepare_attempts": 0,
            }
            state["last_result"] = result
            try:
                self.save_state(state)
            except DeploymentError as error:
                if str(error) != "deployment_state_write_failed":
                    raise
                return self.fail_transition(transition, "state")
            return result

    def cleanup_retired(self, state: dict) -> dict:
        """Only delete versions relinquished by a durable successful transition."""
        self.persistence.require_lock(write=True)
        failed = False
        for sha in list(state["retired"]):
            try:
                self.store.discard_version(sha)
            except Exception:
                failed = True
                break
            del state["retired"][sha]
            self.save_state(state)
        result = {
            "status": "failed" if failed else "success",
            "sha": state["current_sha"],
            "previous_sha": state["previous_sha"],
            "current_sha": state["current_sha"],
            "phase": "cleanup",
            "code": "deployment_cleanup_failed" if failed else None,
            "rollback_result": None,
            "prepare_attempts": 0,
        }
        state["last_result"] = result
        self.save_state(state)
        return result

    def cleanup(self) -> dict:
        with self.locked(create=True):
            state = self.read_state()
            self.require_idle(state)
            if state["current_sha"] is None:
                raise DeploymentError("deployment_no_successful_version")
            return self.cleanup_retired(state)

    def recover(self) -> dict:
        with self.locked(create=True):
            state = self.read_state(recover_owned_candidate=True)
            pending = state["pending"]
            if pending is None:
                raise DeploymentError("deployment_no_recovery_required")
            sha, before = pending["sha"], pending["before_sha"]
            actual_before = self.store.current_target_sha()
            state.update(phase="recovering", prepare_attempts=0)
            self.save_state(state)
            rollback = "not_needed"
            http_restored = False
            try:
                if actual_before != before:
                    self.store.restore(before)
                    rollback = "passed" if before is not None else "no_previous"
                if before is not None and not self.check_health(before):
                    raise DeploymentError("deployment_recovery_failed")
                http_restored = True
                if pending["candidate_owned"]:
                    self.store.discard_candidate(sha)
                if pending["new_version"] and self.store.has_version(sha):
                    # The strict private intent proves this SHA was absent before
                    # this attempt and is not any known successful version. Its
                    # damaged metadata must not block restoring the verified
                    # baseline or disposing of this owned, unsuccessful tree.
                    self.store.discard_version(sha)
            except Exception:
                state.update(
                    current_sha=self.store.current_sha(),
                    phase="recovery_required",
                    rollback_result=rollback if http_restored else "failed",
                    rollback_recorded_at=utc_now(),
                )
                result = {
                    "status": "failed",
                    "sha": sha,
                    "previous_sha": actual_before,
                    "current_sha": state["current_sha"],
                    "phase": "cleanup" if http_restored else "recovery",
                    "code": "deployment_cleanup_failed"
                    if http_restored
                    else "deployment_recovery_failed",
                    "rollback_result": state["rollback_result"],
                    "prepare_attempts": 0,
                }
            else:
                if pending["action"] == "deploy" and (
                    pending["candidate_owned"]
                    or pending["fingerprints"] is not None
                    or pending["failure_phase"] is not None
                ):
                    state.update(
                        failed_sha=sha,
                        failure_recorded_at=utc_now(),
                        failed_phase=pending["failure_phase"] or "interrupted",
                    )
                state.update(
                    current_sha=before,
                    phase="idle",
                    pending=None,
                    rollback_result=rollback,
                    rollback_recorded_at=utc_now(),
                )
                result = {
                    "status": "success",
                    "sha": sha,
                    "previous_sha": actual_before,
                    "current_sha": before,
                    "phase": "recovery",
                    "code": "deployment_recovery_complete",
                    "rollback_result": rollback,
                    "prepare_attempts": 0,
                }
            state["last_result"] = result
            self.save_state(state)
            return result

    def skip(self, state: dict, sha: str, code: str) -> dict:
        state.update(last_observed_sha=sha, last_observed_at=utc_now(), prepare_attempts=0)
        result = {
            "status": "skipped",
            "sha": sha,
            "previous_sha": state["current_sha"],
            "current_sha": state["current_sha"],
            "phase": "check",
            "code": code,
            "rollback_result": None,
            "prepare_attempts": 0,
        }
        state["last_result"] = result
        self.save_state(state)
        return result

    def check_health(self, sha: str) -> bool:
        try:
            return self.health(sha) is True
        except Exception:
            return False

    def status(self) -> dict:
        if not os.path.lexists(self.lock_file):
            if os.path.lexists(self.state_file) or self.store.current_sha() is not None:
                raise DeploymentError("deployment_state_corrupt")
            return {"status": "uninitialized", "state": initial_state()}
        with self.locked(create=False):
            state = self.read_state()
            return {
                "status": "recovery_required" if state["pending"] is not None else "success",
                "state": state,
                "actual_current_sha": self.store.current_sha(),
            }

    def publish_status(self) -> dict:
        """Publish only validated facts; corrupt private data becomes a fixed public error."""
        with self.locked(create=True):
            try:
                state = self.read_state()
                projection = {
                    "schemaVersion": 1,
                    "status": "recovery_required"
                    if state["pending"] is not None
                    else "cleanup_required"
                    if state["retired"]
                    else "uninitialized"
                    if state["last_success_sha"] is None
                    else "available",
                    **{field: state[field] for field in SHA_FIELDS + tuple(FACT_TIMES.values())},
                    **{
                        field: state[field]
                        for field in (
                            "failed_phase",
                            "rollback_result",
                            "rollback_recorded_at",
                            "phase",
                            "updated_at",
                        )
                    },
                    "current_sha": self.store.current_sha(),
                }
            except (DeploymentError, OSError):
                projection = {
                    "schemaVersion": 1,
                    "status": "unavailable",
                    "code": "deployment_status_unavailable",
                }
            self.store.write_public_status(projection)
            return projection
