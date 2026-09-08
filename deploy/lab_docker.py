"""Bounded Docker CLI operations restricted to this lab's named resources."""

from __future__ import annotations

import json
import selectors
import subprocess
import tarfile
import tempfile
from pathlib import Path

from release_store import DeploymentError

NODE_DIGEST = "sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b"
NODE_IMAGE = "node:24.19.0-bookworm@" + NODE_DIGEST
NODE_ECR = "public.ecr.aws/docker/library/node@" + NODE_DIGEST
NGINX_DIGEST = "sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49"
NGINX_IMAGE = "ghcr.io/nginx/nginx-unprivileged:1.30.4-alpine3.24@" + NGINX_DIGEST


class Docker:
    def __init__(self, context: str | None, run_id: str, logs: Path):
        self.prefix = ["docker", *(["--context", context] if context else [])]
        self.run_id, self.logs = run_id, logs
        self.containers, self.networks, self.images, self.volumes = [], [], [], []

    def call(self, *args: str, timeout=60, check=True, log=None) -> subprocess.CompletedProcess:
        try:
            if log:
                with (self.logs / log).open("w") as stream:
                    result = subprocess.run(
                        self.prefix + list(args),
                        stdout=stream,
                        stderr=subprocess.STDOUT,
                        timeout=timeout,
                        text=True,
                    )
            else:
                result = subprocess.run(
                    self.prefix + list(args), capture_output=True, timeout=timeout, text=True
                )
            if check and result.returncode:
                raise DeploymentError("deployment_docker_operation_failed")
            return result
        except subprocess.TimeoutExpired:
            raise DeploymentError("deployment_docker_timeout") from None
        except (OSError, subprocess.SubprocessError):
            raise DeploymentError("deployment_docker_unavailable") from None

    def inspect(self, name: str) -> dict:
        return json.loads(self.call("inspect", name).stdout)[0]

    def image(self, reference: str, digest: str, architecture: str) -> dict:
        result = self.call("image", "inspect", reference, check=False)
        if result.returncode:
            self.call(
                "pull",
                "--platform",
                "linux/" + architecture,
                reference,
                timeout=600,
                log="pull-" + ("node" if digest == NODE_DIGEST else "nginx") + ".log",
            )
            result = self.call("image", "inspect", reference)
        image = json.loads(result.stdout)[0]
        if (
            image.get("Os") != "linux"
            or image.get("Architecture") != architecture
            or not any(ref.endswith("@" + digest) for ref in image.get("RepoDigests", []))
        ):
            raise DeploymentError("deployment_image_identity_rejected")
        return {
            "reference": reference,
            "digest": digest,
            "id": image["Id"],
            "architecture": image["Architecture"],
            "user": image["Config"].get("User", ""),
        }

    def network(self, suffix: str, internal: bool) -> str:
        name = "devhot-lab-" + self.run_id + "-" + suffix
        self.networks.append(name)
        self.call(
            "network",
            "create",
            "--label",
            "devhot.lab.run=" + self.run_id,
            *(["--internal"] if internal else []),
            name,
        )
        data = json.loads(self.call("network", "inspect", name).stdout)[0]
        if data["Internal"] != internal:
            raise DeploymentError("deployment_network_identity_rejected")
        return name

    def create(self, suffix: str, options: list[str], image: str, args: list[str]) -> str:
        name = "devhot-lab-" + self.run_id + "-" + suffix
        self.containers.append(name)
        self.call(
            "create",
            "--name",
            name,
            "--label",
            "devhot.lab.run=" + self.run_id,
            *options,
            image,
            *args,
        )
        return name

    def volume(self) -> str:
        name = "devhot-lab-" + self.run_id + "-storage"
        self.volumes.append(name)
        self.call("volume", "create", "--label", "devhot.lab.run=" + self.run_id, name)
        return name

    def copy_tree(self, source: Path, destination: str) -> None:
        def owned_file(member: tarfile.TarInfo) -> tarfile.TarInfo:
            if not (member.isfile() or member.isdir()):
                raise DeploymentError("deployment_unsafe_artifact")
            member.uid = member.gid = 0
            member.uname = member.gname = "root"
            return member

        try:
            with tempfile.TemporaryFile() as stream:
                with tarfile.open(fileobj=stream, mode="w") as archive:
                    archive.add(source, arcname=".", filter=owned_file)
                stream.seek(0)
                result = subprocess.run(
                    self.prefix + ["cp", "-", destination],
                    stdin=stream,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
            if result.returncode:
                raise DeploymentError("deployment_artifact_transfer_failed")
        except (OSError, subprocess.SubprocessError):
            raise DeploymentError("deployment_artifact_transfer_failed") from None

    def commit_client(self, builder: str) -> str:
        name = "devhot-lab-client:" + self.run_id
        self.images.append(name)
        self.call(
            "commit",
            "--change",
            "LABEL devhot.lab.run=" + self.run_id,
            builder,
            name,
            timeout=300,
            log="client-image.log",
        )
        return name

    def cleanup(self) -> None:
        self.call("info", "--format", "{{.ID}}")
        failures = []
        for kind, names in (
            ("container", self.containers),
            ("network", self.networks),
            ("image", self.images),
            ("volume", self.volumes),
        ):
            for name in reversed(names):
                result = self.call(kind, "inspect", name, check=False)
                if result.returncode:
                    if "No such" not in (result.stderr or ""):
                        failures.append(name)
                    continue
                data = json.loads(result.stdout)[0]
                labels = (
                    data.get("Config", {}).get("Labels", {})
                    if kind in ("container", "image")
                    else data.get("Labels", {})
                )
                if (labels or {}).get("devhot.lab.run") != self.run_id:
                    failures.append(name)
                    continue
                result = self.call(
                    kind,
                    "rm",
                    *(["--force"] if kind == "container" else []),
                    name,
                    check=False,
                    timeout=120,
                )
                if result.returncode:
                    failures.append(name)
        if failures:
            raise DeploymentError("deployment_lab_cleanup_failed")
        self.call("info", "--format", "{{.ID}}")


class BrowserClient:
    def __init__(self, docker: Docker, container: str):
        self.log = (docker.logs / "client-stderr.log").open("w")
        self.process = subprocess.Popen(
            docker.prefix + ["start", "--attach", "--interactive", container],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
            bufsize=1,
        )
        if self.receive(60).get("status") != "ready":
            raise DeploymentError("deployment_browser_unavailable")

    def receive(self, timeout: int) -> dict:
        assert self.process.stdout
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout):
                raise DeploymentError("deployment_browser_timeout")
        try:
            result = json.loads(self.process.stdout.readline())
            if not isinstance(result, dict):
                raise ValueError
            return result
        except ValueError:
            raise DeploymentError("deployment_browser_failed") from None

    def verify(self, sha: str, marker: str) -> dict:
        return self.command({"action": "verify", "sha": sha, "marker": marker})

    def command(self, command: dict) -> dict:
        assert self.process.stdin
        self.process.stdin.write(json.dumps(command) + "\n")
        self.process.stdin.flush()
        result = self.receive(180)
        if result.get("status") != "passed" or (
            "sha" in command and result.get("sha") != command["sha"]
        ):
            raise DeploymentError("deployment_browser_failed")
        return result

    def close(self) -> None:
        try:
            if self.process.poll() is None:
                assert self.process.stdin
                self.process.stdin.write('{"action":"close"}\n')
                self.process.stdin.flush()
                self.process.stdin.close()
                self.process.wait(timeout=30)
            if self.process.returncode:
                raise DeploymentError("deployment_browser_failed")
        finally:
            if self.process.poll() is None:
                self.process.terminate()
                self.process.wait(timeout=10)
            if self.process.stdin and not self.process.stdin.closed:
                self.process.stdin.close()
            if self.process.stdout:
                self.process.stdout.close()
            self.log.close()
