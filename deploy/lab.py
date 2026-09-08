"""One explicit, isolated Docker experiment. No runtime means failure, never skip."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import traceback
import uuid
from pathlib import Path
from urllib.parse import urlparse

from lab_docker import (
    NGINX_DIGEST,
    NGINX_IMAGE,
    NODE_DIGEST,
    NODE_ECR,
    NODE_IMAGE,
    BrowserClient,
    Docker,
)
from lab_source import SourceFixture
from lab_storage import DockerStore
from release_store import DeploymentError, validate_artifact

BUILD_COMMAND = """set -eu
mkdir -p /workspace
cp -a /source/. /workspace/
cd /workspace
node -e '
  if (process.version !== "v24.19.0" ||
      !/^[a-f0-9]{40}$/.test(process.env.DEVHOT_SITE_BUILD_SHA)) process.exit(1)
'
node --version
test ! -e /var/run/docker.sock
test ! -e /releases
test ! -e /state
test ! -e /current
python3 deploy/lab_apt.py
if test -n "${HTTP_PROXY:-}"; then
  cat > /tmp/devhot-lab-apt.conf <<'APT'
Acquire::http::Pipeline-Depth "0";
Acquire::https::Pipeline-Depth "0";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "2";
APT
  export APT_CONFIG=/tmp/devhot-lab-apt.conf
fi
apt-get update -o APT::Update::Error-Mode=any
apt-get install -y --no-install-recommends \\
  git python3 make gcc libc6-dev libssl-dev tar ca-certificates
npm ci
node node_modules/@playwright/test/cli.js install --with-deps chromium firefox webkit
npm run gate
chmod -R a+rX /ms-playwright
"""


def preflight(context: str | None = None) -> dict:
    command = ["docker", *(["--context", context] if context else [])]
    try:
        endpoint = (
            os.environ.get("DOCKER_HOST")
            if not context and not os.environ.get("DOCKER_CONTEXT")
            else None
        )
        if not endpoint:
            selected = context or os.environ.get("DOCKER_CONTEXT")
            if not selected:
                selected = subprocess.check_output(
                    ["docker", "context", "show"], text=True, timeout=10
                ).strip()
            endpoint = subprocess.check_output(
                [
                    "docker",
                    "context",
                    "inspect",
                    selected,
                    "--format",
                    '{{(index .Endpoints "docker").Host}}',
                ],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=10,
            ).strip()
        if not endpoint.startswith("unix:///"):
            raise DeploymentError("deployment_requires_local_unix_socket")
        result = subprocess.run(
            command + ["info", "--format", "{{json .}}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        info = json.loads(result.stdout)
        if info.get("OSType") != "linux" or info.get("Architecture") not in (
            "aarch64",
            "arm64",
            "x86_64",
            "amd64",
        ):
            raise DeploymentError("deployment_unsupported_platform")
        return {
            "status": "passed",
            "phase": "preflight",
            "os": info["OSType"],
            "architecture": info["Architecture"],
            "server_version": info["ServerVersion"],
        }
    except DeploymentError:
        raise
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        raise DeploymentError("deployment_runtime_unavailable") from None


def bind(source: Path, target: str) -> list[str]:
    if "," in str(source) or "\n" in str(source):
        raise DeploymentError("deployment_unsupported_path")
    return ["--mount", "type=bind,source=" + str(source) + ",target=" + target + ",readonly"]


class Lab:
    def __init__(self, project: Path, output: Path, context: str | None):
        resolved_output, resolved_project = output.resolve(), project.resolve()
        if resolved_output.is_relative_to(resolved_project) and not resolved_output.is_relative_to(
            resolved_project / ".cache/deployment-lab"
        ):
            raise DeploymentError("deployment_output_inside_source")
        self.project, self.output, self.context = project, output, context
        self.run_id = uuid.uuid4().hex[:16]
        self.output.mkdir(parents=True, exist_ok=False)
        self.work = output / "work"
        self.work.mkdir()
        self.logs = output / "logs"
        self.logs.mkdir()
        self.docker = Docker(context, self.run_id, self.logs)
        self.events = []
        self.phase = "initializing"
        self.failure_phase = None
        self.client = None
        self.runtime_ready = False

    def record(self, phase: str, **evidence):
        self.phase = phase
        event = {"phase": phase, "status": "passed", **evidence}
        self.events.append(event)
        print(json.dumps({"run_id": self.run_id, **event}), flush=True)
        self.save("running")

    def save(self, status: str, code=None):
        result = {
            "schemaVersion": 1,
            "run_id": self.run_id,
            "status": status,
            "phase": self.phase,
            "failure_phase": self.failure_phase,
            "code": code,
            "events": self.events,
        }
        temporary = self.output / "report.tmp"
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(self.output / "report.json")

    def builder(
        self,
        fixture: SourceFixture,
        store: DockerStore,
        sha: str,
        version: str,
        node_image: str,
        network: str,
    ) -> str:
        self.phase = "build_" + version
        source = self.work / ("source-" + version)
        fixture.export(source)
        options = [
            "--network",
            network,
            "--shm-size",
            "512m",
            "--memory",
            "3g",
            *bind(source, "/source"),
            "--env",
            "DEVHOT_SITE_BUILD_SHA=" + sha,
            "--env",
            "ASTRO_TELEMETRY_DISABLED=1",
            "--env",
            "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
        ]
        proxy = os.environ.get("DEVHOT_LAB_BUILD_PROXY")
        mirror = os.environ.get("DEVHOT_LAB_DEBIAN_MIRROR")
        if mirror is not None:
            if mirror != "ustc":
                raise DeploymentError("deployment_invalid_debian_mirror")
            options += ["--env", "DEVHOT_LAB_DEBIAN_MIRROR=" + mirror]
        if proxy:
            parsed = urlparse(proxy)
            if (
                parsed.scheme not in ("http", "https")
                or parsed.username
                or parsed.password
                or not parsed.hostname
            ):
                raise DeploymentError("deployment_invalid_build_proxy")
            for variable in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                options += ["--env", variable + "=" + proxy]
            options += [
                "--env",
                "NODE_OPTIONS=--use-env-proxy",
                "--env",
                "NO_PROXY=localhost,127.0.0.1,::1",
            ]
        name = self.docker.create(
            "builder-" + version, options, node_image, ["sh", "-ec", BUILD_COMMAND]
        )
        inspected = self.docker.inspect(name)
        if (
            inspected["HostConfig"]["Privileged"]
            or len(inspected["Mounts"]) != 1
            or inspected["Mounts"][0]["Destination"] != "/source"
            or inspected["Mounts"][0]["RW"]
        ):
            raise DeploymentError("deployment_builder_boundary_rejected")
        self.phase = "build_" + version
        self.docker.call(
            "start", "--attach", name, timeout=1800, check=False, log="build-" + version + ".log"
        )
        inspected = self.docker.inspect(name)
        if inspected["State"]["ExitCode"] != 0:
            raise DeploymentError("deployment_build_failed")
        candidate = store.candidates / sha
        candidate.mkdir()
        self.docker.call("cp", name + ":/workspace/dist/.", str(candidate), timeout=120)
        hashes = validate_artifact(candidate, sha)
        self.record(
            "build_" + version,
            sha=sha,
            container_id=inspected["Id"],
            image_id=inspected["Image"],
            started_at=inspected["State"]["StartedAt"],
            finished_at=inspected["State"]["FinishedAt"],
            artifact_files=len(hashes),
            mounts=[
                {"target": mount["Destination"], "read_only": not mount["RW"]}
                for mount in inspected["Mounts"]
            ],
            gate="npm ci + npm run gate",
            debian_mirror=mirror or "image-default",
        )
        return name

    def volume_preflight(self, store: DockerStore, node_image: str, network: str) -> None:
        self.phase = "volume_preflight"
        store.probe_prepare()
        name = self.docker.create(
            "volume-probe",
            [
                "--network",
                network,
                "--user",
                "101:101",
                "--read-only",
                "--cap-drop",
                "ALL",
                *store.releases_mount("/published"),
                "--entrypoint",
                "node",
            ],
            node_image,
            ["-e", "setInterval(()=>{},1000)"],
        )
        self.docker.call("start", name)
        probe = (
            "const fs=require('node:fs');"
            "if(fs.readFileSync('/published/probe/current','utf8')!==process.argv[1])process.exit(1);"
            "try{fs.writeFileSync('/published/forbidden','x');process.exit(1)}"
            "catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}"
        )
        self.docker.call("exec", name, "node", "-e", probe, "v1")
        store.probe_switch()
        self.docker.call("exec", name, "node", "-e", probe, "v2")
        store.probe_remove()
        atomic_reads = store.verify_atomic_reads()
        self.record(
            "volume_preflight",
            native_linux_volume=True,
            same_filesystem=True,
            read_only_volume=True,
            nonroot_read=True,
            atomic_symlink_visible=True,
            concurrent_reads=atomic_reads,
        )

    def nginx(self, store: DockerStore, network: str, source: Path) -> str:
        self.phase = "nginx_start"
        options = [
            "--network",
            network,
            "--user",
            "101:101",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--tmpfs",
            "/tmp:rw,nosuid,noexec,size=64m,mode=1777",
            *store.releases_mount("/usr/share/nginx"),
            *bind(source / "deploy/nginx-serving.conf", "/etc/nginx/conf.d/default.conf"),
            *bind(
                source / "deploy/security-headers.conf", "/etc/nginx/deploy/security-headers.conf"
            ),
            "--entrypoint",
            "nginx",
        ]
        check = self.docker.create("nginx-check", options, NGINX_IMAGE, ["-t"])
        self.docker.call("start", "--attach", check, log="nginx-check.log")
        if self.docker.inspect(check)["State"]["ExitCode"]:
            raise DeploymentError("deployment_nginx_invalid")
        name = self.docker.create("nginx", options, NGINX_IMAGE, ["-g", "daemon off;"])
        self.docker.call("start", name)
        inspected = self.docker.inspect(name)
        if (
            inspected["Config"]["User"] != "101:101"
            or not inspected["HostConfig"]["ReadonlyRootfs"]
            or inspected["HostConfig"].get("PortBindings")
            or any(mount["RW"] for mount in inspected["Mounts"])
        ):
            raise DeploymentError("deployment_nginx_boundary_rejected")
        uid = self.docker.call("exec", name, "id", "-u").stdout.strip()
        version = self.docker.call("exec", name, "nginx", "-v")
        if "nginx/1.30.4" not in version.stdout + version.stderr:
            raise DeploymentError("deployment_image_identity_rejected")
        denied = self.docker.call(
            "exec", name, "sh", "-c", "touch /usr/share/nginx/forbidden", check=False
        )
        if uid != "101" or denied.returncode == 0:
            raise DeploymentError("deployment_nginx_boundary_rejected")
        self.record(
            "nginx_started",
            container_id=inspected["Id"],
            image_id=inspected["Image"],
            started_at=inspected["State"]["StartedAt"],
            uid=uid,
            nginx_version="1.30.4",
            read_only=True,
            published_ports=False,
        )
        return name

    def run(self) -> None:
        status, code = "failed", "deployment_lab_failed"
        try:
            self.phase = "preflight"
            runtime = preflight(self.context)
            self.runtime_ready = True
            architecture = {
                "aarch64": "arm64",
                "arm64": "arm64",
                "x86_64": "amd64",
                "amd64": "amd64",
            }[runtime["architecture"]]
            self.record(
                "preflight", architecture=architecture, server_version=runtime["server_version"]
            )
            self.phase = "images"
            node_image = os.environ.get("DEVHOT_LAB_NODE_IMAGE", NODE_IMAGE)
            if node_image not in (NODE_IMAGE, NODE_ECR):
                raise DeploymentError("deployment_image_identity_rejected")
            node = self.docker.image(node_image, NODE_DIGEST, architecture)
            nginx = self.docker.image(NGINX_IMAGE, NGINX_DIGEST, architecture)
            if nginx["user"] not in ("101", "101:101"):
                raise DeploymentError("deployment_image_identity_rejected")
            self.record("images", node=node, nginx=nginx)
            self.phase = "networks"
            build_network = self.docker.network("build", False)
            service_network = self.docker.network("service", True)
            self.record("networks", service_internal=True, build_is_separate=True)
            self.phase = "source_snapshot"
            fixture = SourceFixture(self.project, self.work / "source-repository")
            self.phase = "volume_preflight"
            store = DockerStore(
                self.docker,
                self.work,
                fixture.root / "deploy/release_store.py",
                node_image,
                service_network,
            )
            self.volume_preflight(store, node_image, service_network)
            marker1, marker2 = "LAB-V1-" + self.run_id, "LAB-V2-" + self.run_id
            self.phase = "source_v1"
            first = fixture.version(marker1)
            builder1 = self.builder(fixture, store, first, "v1", node_image, build_network)
            self.phase = "client_image"
            client_image = self.docker.commit_client(builder1)
            self.phase = "activate_v1"
            store.activate(store.candidates / first, first)
            self.record("activate_v1", sha=first, current_sha=store.current_sha())
            server = self.nginx(store, service_network, fixture.root)
            before = self.docker.inspect(server)
            options = [
                "--interactive",
                "--network",
                service_network,
                "--user",
                "1000:1000",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges=true",
                "--tmpfs",
                "/tmp:rw,nosuid,size=512m,mode=1777",
                "--shm-size",
                "256m",
                "--env",
                "HOME=/tmp",
                "--env",
                "NODE_OPTIONS=",
                "--env",
                "HTTP_PROXY=",
                "--env",
                "HTTPS_PROXY=",
                "--env",
                "ALL_PROXY=",
                "--env",
                "http_proxy=",
                "--env",
                "https_proxy=",
                "--env",
                "all_proxy=",
                *bind(fixture.root / "deploy/lab-client.cjs", "/probe.cjs"),
                "--entrypoint",
                "node",
            ]
            self.phase = "client_start"
            client = self.docker.create("client", options, client_image, ["/probe.cjs", server])
            self.client = BrowserClient(self.docker, client)
            self.phase = "http_v1"
            self.record(
                "http_v1",
                **{
                    key: value
                    for key, value in self.client.verify(first, marker1).items()
                    if key != "status"
                },
            )
            self.phase = "source_v2"
            second = fixture.version(marker2)
            self.builder(fixture, store, second, "v2", node_image, build_network)
            self.phase = "activate_v2"
            if store.current_sha() != first or not self.docker.inspect(server)["State"]["Running"]:
                raise DeploymentError("deployment_prepare_changed_current")
            store.activate(store.candidates / second, second)
            self.record(
                "activate_v2", sha=second, previous_sha=first, current_sha=store.current_sha()
            )
            self.phase = "http_v2"
            self.record(
                "http_v2",
                **{
                    key: value
                    for key, value in self.client.verify(second, marker2).items()
                    if key != "status"
                },
            )
            self.phase = "isolation"
            after = self.docker.inspect(server)
            if (
                before["Id"] != after["Id"]
                or before["State"]["StartedAt"] != after["State"]["StartedAt"]
            ):
                raise DeploymentError("deployment_nginx_restarted")
            address = after["NetworkSettings"]["Networks"][service_network]["IPAddress"]
            outsider = self.docker.create(
                "outsider",
                ["--network", build_network, "--entrypoint", "node"],
                node_image,
                [
                    "-e",
                    "const net=require('node:net');"
                    "const s=net.connect({host:process.argv[1],port:8080});"
                    "s.on('connect',()=>process.exit(1));"
                    "s.on('error',()=>process.exit(0));"
                    "s.setTimeout(2000,()=>process.exit(0));",
                    address,
                ],
            )
            self.docker.call("start", "--attach", outsider)
            if self.docker.inspect(outsider)["State"]["ExitCode"] != 0:
                raise DeploymentError("deployment_network_isolation_failed")
            self.record(
                "isolation",
                nginx_container_id=after["Id"],
                nginx_started_at=after["State"]["StartedAt"],
                nginx_not_restarted=True,
                unapproved_client="blocked",
                host_ports="none",
            )
            self.phase = "client_cleanup"
            self.client.close()
            self.client = None
            status, code = "passed", None
        except Exception as error:
            code = str(error) if isinstance(error, DeploymentError) else "deployment_lab_failed"
            self.failure_phase = self.phase
            self.events.append({"phase": self.phase, "status": "failed", "code": code})
            with (self.logs / "internal-error.log").open("w") as stream:
                traceback.print_exc(file=stream)
            raise DeploymentError(code) from None
        finally:
            cleanup_errors = []
            try:
                if self.client:
                    self.client.close()
            except Exception:
                cleanup_errors.append("browser")
            try:
                if self.runtime_ready:
                    self.docker.cleanup()
            except Exception:
                cleanup_errors.append("docker")
            if cleanup_errors:
                status, code = "failed", "deployment_lab_cleanup_failed"
                self.save(status, code)
                raise DeploymentError(code) from None
            try:
                shutil.rmtree(self.work)
                self.record("cleanup", owned_resources_removed=True)
            except OSError:
                self.save("failed", "deployment_lab_cleanup_failed")
                raise DeploymentError("deployment_lab_cleanup_failed") from None
            self.save(status, code)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--context")
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.preflight:
            print(json.dumps(preflight(arguments.context)))
        else:
            project = Path(__file__).resolve().parent.parent
            output = arguments.output or project / ".cache/deployment-lab" / uuid.uuid4().hex
            lab = Lab(project, output.absolute(), arguments.context)
            lab.run()
            print(json.dumps({"status": "passed", "run_id": lab.run_id}))
        return 0
    except DeploymentError as error:
        print(json.dumps({"status": "failed", "code": str(error)}))
        return 1
    except OSError:
        print(json.dumps({"status": "failed", "code": "deployment_output_unavailable"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
