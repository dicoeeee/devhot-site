"""Actual host-port regression; loopback fixtures do not claim real LAN acceptance."""

from __future__ import annotations

import socket
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

from host_config import compose_plan
from release_store import DeploymentError


def verify_host_port(docker):
    plan = compose_plan(
        SimpleNamespace(
            lan_ipv4="127.0.0.1",
            tool_root=Path("/opt/devhot-site"),
            release_root=Path("/srv/devhot-site"),
        )
    )
    service = plan["services"]["nginx"]
    internal = plan["networks"]["service"]["internal"]
    opener = build_opener(ProxyHandler({}))
    evidence = []
    for suffix, isolated in (("host-port", internal), ("internal-port-control", True)):
        network = docker.network(suffix, isolated)
        # Probe the production network policy with the image's default site on loopback.
        # Production release/config mounts and journald are outside this port-only fixture.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            requested = reservation.getsockname()[1]
        container = docker.create(
            suffix,
            [
                "--network",
                network,
                "--publish",
                f"127.0.0.1:{requested}:8080",
                "--read-only",
                "--user",
                service["user"],
                "--cap-drop",
                "ALL",
                "--security-opt",
                service["security_opt"][0],
                "--tmpfs",
                "/tmp:rw,nosuid,noexec,size=64m,mode=1777",
                "--log-driver",
                "none",
                "--entrypoint",
                "nginx",
            ],
            service["image"],
            service["command"],
        )
        docker.call("start", container)
        value = docker.inspect(container)
        expected = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(requested)}]}
        ports = value["NetworkSettings"]["Ports"]
        if not value["State"]["Running"]:
            raise DeploymentError("deployment_host_port_server_failed")
        if not isolated and ports != expected:
            raise DeploymentError("deployment_host_port_missing")
        if isolated and ports.get("8080/tcp"):
            raise DeploymentError("deployment_internal_port_unexpected")
        reached = False
        for _ in range(20):
            try:
                with opener.open(f"http://127.0.0.1:{requested}/", timeout=0.5) as response:
                    reached = response.status == 200 and b"Welcome to nginx!" in response.read(
                        65536
                    )
            except (OSError, URLError):
                pass
            if reached:
                break
            time.sleep(0.1)
        if reached == isolated:
            raise DeploymentError("deployment_host_port_http_failed")
        evidence.append(dict(internal=isolated, published=not isolated, http_200=reached))
        docker.call("rm", "--force", container)
        docker.containers.remove(container)
        docker.call("network", "rm", network)
        docker.networks.remove(network)
    if internal is not False:
        raise DeploymentError("deployment_production_network_unpublishable")
    return dict(cases=evidence, endpoint="loopback_ephemeral", real_rootless_lan=False)
