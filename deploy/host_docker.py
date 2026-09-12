"""Explicit Rootless Docker endpoint and narrowly scoped production containers."""

from __future__ import annotations

import json
import re
from pathlib import Path

from deployment_controller import PreparationUnavailable
from host_config import HostConfig, compose_plan
from host_io import command_environment, read_root_json, run
from lab_docker import NGINX_IMAGE, NODE_IMAGE
from release_store import DeploymentError, checked_sha

BUILDER_SECURITY = [
    "--shm-size=512m",
    "--memory=4g",
    "--pids-limit=512",
    "--cap-drop=NET_RAW",
    "--security-opt",
    "no-new-privileges:true",
]


def builder_arguments(config: HostConfig, source: str, sha: str, nonce: str) -> list[str]:
    checked_sha(sha)
    if not re.fullmatch("[0-9a-f]{16}", nonce) or "," in source or "\n" in source:
        raise DeploymentError("deployment_invalid_builder")
    return [
        "create",
        "--name",
        "devhot-site-builder-" + nonce,
        "--label",
        "devhot.site.builder=1",
        "--label",
        "devhot.site.sha=" + sha,
        "--label",
        "devhot.site.instance=" + str(config.uid),
        "--log-driver=none",
        *BUILDER_SECURITY,
        "--env",
        "ASTRO_TELEMETRY_DISABLED=1",
        "--env",
        "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
        "--env",
        "DEVHOT_NGINX_SOURCE_TARBALL=/prepared/nginx-source.tar.gz",
        "--env",
        "DEVHOT_SITE_BUILD_SHA=" + sha,
        "--mount",
        "type=bind,source=" + source + ",target=/source,readonly",
        "--entrypoint",
        "/bin/sh",
        NODE_IMAGE,
        "-c",
        "exec sleep infinity",
    ]


def nginx_matches(config: HostConfig, value: dict, *, running: bool = True) -> bool:
    plan = compose_plan(config)["services"]["nginx"]
    try:
        host, container = value["HostConfig"], value["Config"]
        mounts = sorted(
            (m["Type"], m["Source"], m["Destination"], m["RW"]) for m in value["Mounts"]
        )
        expected = sorted(("bind", m["source"], m["target"], False) for m in plan["volumes"])
        ports = {"8080/tcp": [{"HostIp": config.lan_ipv4, "HostPort": "80"}]}
        return (
            container["Image"] == NGINX_IMAGE
            and container["User"] == "101:101"
            and container["Entrypoint"] == plan["entrypoint"]
            and container["Cmd"] == plan["command"]
            and container["Labels"].get("devhot.site.managed") == "1"
            and host["ReadonlyRootfs"] is True
            and host["Privileged"] is False
            and not host["CapAdd"]
            and host["CapDrop"] == ["ALL"]
            and host["SecurityOpt"] == ["no-new-privileges:true"]
            and host["PidMode"] == ""
            and host["IpcMode"] == "private"
            and not host["Devices"]
            and not host["VolumesFrom"]
            and not host["Binds"]
            and host["Tmpfs"] == {"/tmp": "rw,nosuid,noexec,size=64m,mode=1777"}
            and host["PortBindings"] == ports
            and host["RestartPolicy"]["Name"] == "unless-stopped"
            and host["LogConfig"] == {"Type": "journald", "Config": {"tag": "devhot-site-nginx"}}
            and mounts == expected
            and host["NetworkMode"] == "devhot-site_service"
            and set(value["NetworkSettings"]["Networks"]) == {"devhot-site_service"}
            and (
                not running
                or (
                    value["State"]["Running"] is True and value["NetworkSettings"]["Ports"] == ports
                )
            )
        )
    except (KeyError, TypeError, ValueError):
        return False


class RootlessDocker:
    def __init__(self, config: HostConfig):
        self.config = config
        self.environment = command_environment(config.uid)

    def call(self, *arguments: str, timeout: float = 30, check: bool = True):
        return run(
            ["/usr/bin/docker", "--host", "unix://" + str(self.config.socket), *arguments],
            self.environment,
            timeout=timeout,
            check=check,
        )

    def inspect(self, kind: str, name: str) -> dict:
        return json.loads(self.call(kind, "inspect", name).stdout)[0]

    def image(self, image: str, *, pull: bool = True) -> None:
        if image not in (NODE_IMAGE, NGINX_IMAGE):
            raise DeploymentError("deployment_unapproved_image")
        result = self.call("image", "inspect", image, check=False)
        if result.returncode:
            if not pull:
                raise DeploymentError("deployment_image_unavailable")
            try:
                response = self.call("pull", image, timeout=240, check=False)
            except DeploymentError as error:
                if str(error) == "deployment_command_timeout":
                    raise PreparationUnavailable() from None
                raise
            if response.returncode:
                raise PreparationUnavailable()
        info = self.inspect("image", image)
        daemon = json.loads(self.call("info", "--format", "{{json .}}").stdout)
        architecture = {"aarch64": "arm64", "x86_64": "amd64"}.get(
            daemon["Architecture"], daemon["Architecture"]
        )
        if (
            info.get("Os") != "linux"
            or info.get("Architecture") != architecture
            or not any(
                value.endswith("@" + image.split("@")[1]) for value in info.get("RepoDigests", [])
            )
        ):
            raise DeploymentError("deployment_image_identity_failed")

    def checked_compose(self) -> Path:
        path = Path("/etc/devhot-site/compose.json")
        if read_root_json(path, self.config.gid) != compose_plan(self.config):
            raise DeploymentError("deployment_compose_configuration_mismatch")
        return path

    def check_nginx(self) -> None:
        self.checked_compose()
        value = self.inspect("container", "devhot-site-nginx")
        self.image(NGINX_IMAGE, pull=False)
        if (
            not nginx_matches(self.config, value)
            or value["Image"] != self.inspect("image", NGINX_IMAGE)["Id"]
        ):
            raise DeploymentError("deployment_nginx_configuration_mismatch")
        network = self.inspect("network", "devhot-site_service")
        if (
            network.get("Internal") is not False
            or network.get("EnableIPv6") is not False
            or network.get("Driver") != "bridge"
            or network.get("Labels", {}).get("devhot.site.managed") != "1"
        ):
            raise DeploymentError("deployment_network_configuration_mismatch")

    def serve(self) -> dict:
        plan = self.checked_compose()
        existing = self.call(
            "container", "ls", "--all", "--format", "{{.Names}}"
        ).stdout.splitlines()
        if "devhot-site-nginx" in existing:
            self.check_nginx()
            return {"status": "skipped", "code": "deployment_nginx_already_running"}
        self.image(NGINX_IMAGE)
        networks = self.call("network", "ls", "--format", "{{.Name}}").stdout.splitlines()
        if "devhot-site_service" in networks:
            network = self.inspect("network", "devhot-site_service")
            if (
                network.get("Internal") is not False
                or network.get("EnableIPv6") is not False
                or network.get("Driver") != "bridge"
                or network.get("Labels", {}).get("devhot.site.managed") != "1"
            ):
                raise DeploymentError("deployment_network_configuration_mismatch")
        prefix = ("compose", "--env-file", "/dev/null", "--file", str(plan))
        self.call(*prefix, "config", "--quiet")
        self.call(*prefix, "run", "--rm", "--no-deps", "nginx", "-t")
        self.call(
            *prefix, "up", "--detach", "--no-build", "--no-recreate", "--pull", "never", "nginx"
        )
        self.check_nginx()
        return {"status": "success", "code": None}
