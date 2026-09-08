"""Exercise the release store on the daemon's native Linux filesystem."""

from __future__ import annotations

import json
import os
from pathlib import Path

from lab_docker import Docker
from release_store import DeploymentError, checked_sha, discard_candidate, validate_artifact


class DockerStore:
    @classmethod
    def attach(cls, docker: Docker, candidates: Path, container: str):
        """Attach to an experiment-owned controller; do not acquire ownership for cleanup."""
        store = cls.__new__(cls)
        store.docker, store.candidates, store.container = docker, candidates, container
        return store

    def __init__(self, docker: Docker, work: Path, module: Path, image: str, network: str):
        self.docker = docker
        self.candidates = work / "exported-candidates"
        self.candidates.mkdir(mode=0o700)
        self.volume = docker.volume()
        if "," in str(module) or "\n" in str(module):
            raise DeploymentError("deployment_unsupported_path")
        self.container = docker.create(
            "storage-controller",
            [
                "--network",
                network,
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges=true",
                "--mount",
                "type=volume,source=" + self.volume + ",target=/storage,volume-nocopy",
                "--mount",
                "type=bind,source=" + str(module) + ",target=/release_store.py,readonly",
                "--mount",
                "type=bind,source="
                + str(module.with_name("lab_storage_probe.py"))
                + ",target=/lab_storage_probe.py,readonly",
                "--entrypoint",
                "python3",
            ],
            image,
            ["-c", "import time; time.sleep(7200)"],
        )
        docker.call("start", self.container)
        self.execute("store.initialize()")

    def execute(self, script: str, *arguments: str) -> str:
        # Only literal scripts from this module are executed. SHA values stay argv data.
        prefix = (
            "import json, os, sys; from pathlib import Path; "
            "sys.path.insert(0, '/'); from release_store import ReleaseStore; "
            "store=ReleaseStore(Path('/storage')); "
        )
        result = self.docker.call(
            "exec", self.container, "python3", "-c", prefix + script, *arguments, check=False
        )
        if result.returncode:
            (self.docker.logs / "storage-error.log").write_text(result.stderr)
            raise DeploymentError("deployment_storage_operation_failed")
        return result.stdout

    def releases_mount(self, target: str) -> list[str]:
        return [
            "--mount",
            "type=volume,source="
            + self.volume
            + ",target="
            + target
            + ",volume-subpath=releases,readonly,volume-nocopy",
        ]

    def has_candidate(self, sha: str) -> bool:
        checked_sha(sha)
        return os.path.lexists(self.candidates / sha) or json.loads(
            self.execute("print(json.dumps(store.has_candidate(sys.argv[1])))", sha)
        )

    def discard_candidate(self, sha: str) -> None:
        checked_sha(sha)
        # The durable controller intent owns both transfer locations. Clear the
        # native copy first; failure leaves the local copy and intent retryable.
        self.execute("store.discard_candidate(sys.argv[1])", sha)
        discard_candidate(self.candidates / sha)

    def current_sha(self) -> str | None:
        return json.loads(self.execute("print(json.dumps(store.current_sha()))"))

    def current_target_sha(self) -> str | None:
        return json.loads(self.execute("print(json.dumps(store.current_target_sha()))"))

    @property
    def state_exclusions(self) -> tuple[Path, ...]:
        return (self.candidates,)

    def check_layout(self) -> None:
        self.execute("store.check_layout()")

    def restore(self, sha: str | None) -> dict:
        if sha is not None:
            checked_sha(sha)
        return json.loads(
            self.execute(
                "print(json.dumps(store.restore(json.loads(sys.argv[1]))))", json.dumps(sha)
            )
        )

    def has_version(self, sha: str) -> bool:
        checked_sha(sha)
        return json.loads(self.execute("print(json.dumps(store.has_version(sys.argv[1])))", sha))

    def discard_version(self, sha: str) -> None:
        checked_sha(sha)
        self.execute("store.discard_version(sys.argv[1])", sha)

    def version_fingerprints(self, sha: str) -> dict:
        checked_sha(sha)
        return json.loads(
            self.execute("print(json.dumps(store.version_fingerprints(sys.argv[1])))", sha)
        )

    def write_public_status(self, projection: dict) -> None:
        self.execute("store.write_public_status(json.loads(sys.argv[1]))", json.dumps(projection))

    def activate(self, candidate: Path, sha: str) -> dict:
        checked_sha(sha)
        if candidate != self.candidates / sha:
            raise DeploymentError("deployment_invalid_candidate")
        validate_artifact(candidate, sha)
        self.execute("(store.candidates / sys.argv[1]).mkdir()", sha)
        self.docker.copy_tree(candidate, self.container + ":/storage/candidates/" + sha)
        return json.loads(
            self.execute(
                "print(json.dumps(store.activate(store.candidates / sys.argv[1], sys.argv[1])))",
                sha,
            )
        )

    def probe_prepare(self) -> None:
        self.execute(
            "p=store.releases / 'probe'; p.mkdir(mode=0o755); "
            "(p / 'v1').write_text('v1'); (p / 'v1').chmod(0o644); "
            "(p / 'v2').write_text('v2'); (p / 'v2').chmod(0o644); "
            "(p / 'current').symlink_to('v1'); "
            "assert store.candidates.stat().st_dev == store.versions.stat().st_dev"
        )

    def probe_switch(self) -> None:
        self.execute(
            "p=store.releases / 'probe'; (p / 'next').symlink_to('v2'); "
            "os.replace(p / 'next', p / 'current')"
        )

    def probe_remove(self) -> None:
        self.execute("import shutil; shutil.rmtree(store.releases / 'probe')")

    def verify_atomic_reads(self) -> dict:
        return json.loads(
            self.execute(
                "from lab_storage_probe import verify_atomic_reads; "
                "print(json.dumps(verify_atomic_reads(store.root)))"
            )
        )
