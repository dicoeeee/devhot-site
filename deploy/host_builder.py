"""One disposable builder, split network preparation from the complete gate."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tempfile
import uuid
from pathlib import Path

from deployment_controller import DeploymentFailure, PreparationUnavailable
from host_docker import NODE_IMAGE, builder_arguments
from host_source import export_tree, fetch_main
from release_store import DeploymentError, validate_artifact

PREPARE_COMMAND = """set -eu
mkdir -p /workspace
cp -a /source/. /workspace/
cd /workspace
node -e 'if (process.version !== "v24.19.0") process.exit(1)'
apt-get update -o APT::Update::Error-Mode=any -o Acquire::Retries=0
apt-get install -y --no-install-recommends \\
  git python3 make gcc libc6-dev libssl-dev tar ca-certificates
npm ci
node node_modules/@playwright/test/cli.js install --with-deps chromium firefox webkit
mkdir -p /prepared
node tools/prepare-nginx-source.ts "$DEVHOT_NGINX_SOURCE_TARBALL"
"""
BUILD_COMMAND = """set -eu
cd /workspace
npm run gate
"""


def preparation_failure(output: str) -> str:
    lower = output.lower()
    deterministic = ("etarget", "eusage", "e401", "e403", "e404", "package-lock.json", "eresolve")
    if any(code in lower for code in deterministic):
        return "dependencies"
    transient = (
        "eai_again",
        "econnreset",
        "etimedout",
        "econnrefused",
        "enetunreach",
        "connection timed out",
        "temporary failure resolving",
        "failed to download browser",
        "could not resolve",
        "connection failed",
        "failed to fetch",
        "network is unreachable",
        "fetch failed",
        "und_err_connect_timeout",
        "timeouterror",
        "deployment_nginx_source_unavailable",
        "tarball sha256 mismatch",
    )
    return "prepare" if any(code in lower for code in transient) else "dependencies"


def validate_owned_artifact(candidate, sha, uid, gid):
    validate_artifact(candidate, sha)
    for path in (candidate, *candidate.rglob("*")):
        value = path.lstat()
        if (
            value.st_uid != uid
            or value.st_gid != gid
            or value.st_mode & 0o022
            or (stat.S_ISREG(value.st_mode) and value.st_nlink != 1)
        ):
            raise DeploymentFailure("artifact")


class HostBuilder:
    def __init__(self, config, docker, emit):
        self.config, self.docker, self.emit = config, docker, emit
        self.work = None
        self.name = None

    def dispose(self):
        if self.name:
            # A failed removal is actionable: retain ownership for explicit recovery.
            self.docker.call("rm", "--force", self.name)
            self.name = None
        if self.work:
            shutil.rmtree(self.work)
            self.work = None

    def recover_builders(self):
        names = self.docker.call(
            "container",
            "ls",
            "--all",
            "--filter",
            "label=devhot.site.builder=1",
            "--format",
            "{{.Names}}",
        ).stdout.splitlines()
        for name in names:
            value = self.docker.inspect("container", name)
            labels = value["Config"].get("Labels", {})
            mounts = value["Mounts"]
            if (
                not re.fullmatch("devhot-site-builder-[0-9a-f]{16}", name)
                or labels.get("devhot.site.instance") != str(self.config.uid)
                or value["Config"]["Image"] != NODE_IMAGE
                or len(mounts) != 1
            ):
                raise DeploymentError("deployment_unowned_builder")
            mount = mounts[0]
            source = Path(mount["Source"])
            if (
                mount["Type"] != "bind"
                or mount["Destination"] != "/source"
                or mount["RW"] is not False
                or source.name != "source"
                or source.parent.parent != self.config.state_root
                or not re.fullmatch("prepare-[a-z0-9_]+", source.parent.name)
            ):
                raise DeploymentError("deployment_unowned_builder")
            self.docker.call("rm", "--force", name)
        for work in self.config.state_root.glob("prepare-*"):
            marker = work / ".owned-preparation"
            if (
                work.is_symlink()
                or not work.is_dir()
                or work.stat().st_uid != os.getuid()
                or marker.is_symlink()
                or not marker.is_file()
                or marker.stat().st_size > 1024
            ):
                raise DeploymentError("deployment_unowned_preparation")
            value = json.loads(marker.read_text())
            if (
                set(value) != {"sha", "schemaVersion"}
                or value["schemaVersion"] != 1
                or re.fullmatch("[0-9a-f]{40}", value["sha"]) is None
            ):
                raise DeploymentError("deployment_unowned_preparation")
            shutil.rmtree(work)

    def prepare(self, sha):
        self.dispose()
        self.work = Path(tempfile.mkdtemp(prefix="prepare-", dir=self.config.state_root))
        marker = self.work / ".owned-preparation"
        marker.write_text(json.dumps({"sha": sha, "schemaVersion": 1}))
        marker.chmod(0o600)
        self.emit("fetch", sha, "started")
        bare = self.work / "source.git"
        fetch_main(bare, sha, self.docker.environment)
        export_tree(bare, sha, self.work / "source", self.docker.environment)
        self.emit("fetch", sha, "success")
        self.docker.image(NODE_IMAGE)
        nonce = uuid.uuid4().hex[:16]
        args = builder_arguments(self.config, str(self.work / "source"), sha, nonce)
        self.docker.call(*args)
        self.name = "devhot-site-builder-" + nonce
        self.docker.call("start", self.name)
        self.emit("dependencies", sha, "started")
        try:
            result = self.docker.call(
                "exec", self.name, "/bin/sh", "-c", PREPARE_COMMAND, check=False, timeout=1200
            )
        except DeploymentError as error:
            if str(error) == "deployment_command_timeout":
                raise PreparationUnavailable() from None
            raise
        if result.returncode:
            if preparation_failure(result.stdout + result.stderr) == "prepare":
                raise PreparationUnavailable()
            raise DeploymentFailure("dependencies")
        self.emit("dependencies", sha, "success")

    def build(self, sha):
        if self.name is None:
            raise DeploymentFailure("prepare")
        self.emit("input", sha, "started")
        result = self.docker.call(
            "exec",
            self.name,
            "/bin/sh",
            "-c",
            "cd /workspace && npm run validate:input",
            check=False,
            timeout=120,
        )
        if result.returncode:
            raise DeploymentFailure("input")
        self.emit("input", sha, "success")
        self.emit("build", sha, "started")
        result = self.docker.call(
            "exec", self.name, "/bin/sh", "-c", BUILD_COMMAND, check=False, timeout=1800
        )
        if result.returncode:
            raise DeploymentFailure("build")
        self.emit("build", sha, "success")
        candidate = self.config.release_root / "candidates" / sha
        candidate.mkdir(mode=0o700)
        self.docker.call("cp", self.name + ":/workspace/dist/.", str(candidate), timeout=120)
        self.emit("artifact", sha, "started")
        try:
            validate_owned_artifact(candidate, sha, self.config.uid, self.config.gid)
        except DeploymentError:
            raise DeploymentFailure("artifact") from None
        self.emit("artifact", sha, "success")
        self.dispose()
        return candidate
