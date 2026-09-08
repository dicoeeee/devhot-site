"""Strict concurrent-read assertions on the actual Linux deployment filesystem."""

from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path

from release_store import DeploymentError, ReleaseStore


def verify_trial(root: Path, first: str, second: str) -> int:
    store = ReleaseStore(root)
    store.initialize()
    for sha in (first, second):
        candidate = store.candidates / sha
        candidate.mkdir()
        (candidate / "index.html").write_text(sha)
        (candidate / "release.json").write_text(json.dumps({"schemaVersion": 1, "buildSha": sha}))
        (candidate / "_publication.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "buildSha": sha,
                    "routes": ["/"],
                    "assets": [],
                }
            )
        )
    store.activate(store.candidates / first, first)
    observed, errors = [], []
    ready, changed, stop = threading.Event(), threading.Event(), threading.Event()

    def reader():
        while not stop.is_set():
            try:
                sha = json.loads((store.releases / "current/release.json").read_text())["buildSha"]
                observed.append(sha)
                if sha == first:
                    ready.set()
                if sha == second:
                    changed.set()
            except Exception as error:
                errors.append(error)
                ready.set()
                changed.set()
                return

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        if not ready.wait(2):
            raise DeploymentError("deployment_atomic_read_failed")
        store.activate(store.candidates / second, second)
        if not changed.wait(2):
            raise DeploymentError("deployment_atomic_read_failed")
    finally:
        stop.set()
        thread.join(2)
    if thread.is_alive() or errors or set(observed) != {first, second}:
        raise DeploymentError("deployment_atomic_read_failed")
    if (store.versions / first / "index.html").read_text() != first:
        raise DeploymentError("deployment_atomic_read_failed")
    return len(observed)


def verify_atomic_reads(root: Path) -> dict:
    probe = root / "atomic-read-probe"
    probe.mkdir()
    try:
        total_reads = sum(
            verify_trial(probe / str(trial), "a" * 40, "b" * 40) for trial in range(16)
        )
        return {"trials": 16, "reads": total_reads, "read_errors": 0, "complete_old_or_new": True}
    finally:
        shutil.rmtree(probe)
