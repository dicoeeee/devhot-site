"""Validated VM-local configuration and deterministic installation artifacts."""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from pathlib import Path

from host_daemon import daemon_unit
from lab_docker import NGINX_IMAGE
from release_store import DeploymentError


@dataclass(frozen=True)
class RootlessKitIdentity:
    path: str
    sha256: str
    device: int
    inode: int


@dataclass(frozen=True)
class HostConfig:
    account: str
    uid: int
    gid: int
    lan_ipv4: str
    allowed_ipv4_cidrs: tuple[str, ...]
    release_root: Path
    state_root: Path
    tool_root: Path
    rootlesskit: RootlessKitIdentity

    @property
    def runtime_root(self) -> Path:
        return Path("/run/user") / str(self.uid) / "devhot-site"

    @property
    def socket(self) -> Path:
        return self.runtime_root.parent / "docker.sock"


PRIVATE_NETWORKS = tuple(
    ipaddress.IPv4Network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


def safe_path(value: str, prefix: str) -> Path:
    if not isinstance(value, str) or not re.fullmatch(r"/[A-Za-z0-9/_-]+", value):
        raise ValueError
    path = Path(value)
    if str(path) != value or not path.is_relative_to(prefix) or path == Path(prefix):
        raise ValueError
    return path


def parse_config(value: dict) -> HostConfig:
    try:
        expected = {
            "schemaVersion",
            "account",
            "uid",
            "gid",
            "lan_ipv4",
            "allowed_ipv4_cidrs",
            "release_root",
            "state_root",
            "tool_root",
            "rootlesskit",
        }
        if not isinstance(value, dict) or set(value) != expected:
            raise ValueError
        if (
            type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or value["account"] != "devhot-site"
        ):
            raise ValueError
        if any(type(value[k]) is not int or not 1 <= value[k] < 2**31 for k in ("uid", "gid")):
            raise ValueError
        address = ipaddress.IPv4Address(value["lan_ipv4"])
        if str(address) != value["lan_ipv4"] or not any(address in net for net in PRIVATE_NETWORKS):
            raise ValueError
        cidrs = value["allowed_ipv4_cidrs"]
        if (
            not isinstance(cidrs, list)
            or not 1 <= len(cidrs) <= 64
            or len(set(cidrs)) != len(cidrs)
        ):
            raise ValueError
        for cidr in cidrs:
            network = ipaddress.IPv4Network(cidr, strict=True)
            if str(network) != cidr or not any(network.subnet_of(net) for net in PRIVATE_NETWORKS):
                raise ValueError
        identity = value["rootlesskit"]
        if not isinstance(identity, dict) or set(identity) != {"path", "sha256", "device", "inode"}:
            raise ValueError
        binary = (
            safe_path(identity["path"], "/usr")
            if identity["path"].startswith("/usr/")
            else safe_path(identity["path"], "/opt")
        )
        if (
            binary.name != "rootlesskit"
            or not re.fullmatch(r"[0-9a-f]{64}", identity["sha256"])
            or identity["sha256"] == "0" * 64
        ):
            raise ValueError
        if any(type(identity[k]) is not int or identity[k] < 1 for k in ("device", "inode")):
            raise ValueError
        return HostConfig(
            account=value["account"],
            uid=value["uid"],
            gid=value["gid"],
            lan_ipv4=str(address),
            allowed_ipv4_cidrs=tuple(cidrs),
            release_root=safe_path(value["release_root"], "/srv"),
            state_root=safe_path(value["state_root"], "/var/lib"),
            tool_root=safe_path(value["tool_root"], "/opt"),
            rootlesskit=RootlessKitIdentity(**identity),
        )
    except (ValueError, KeyError, TypeError, AttributeError):
        raise DeploymentError("deployment_invalid_host_config") from None


def compose_plan(config: HostConfig) -> dict:
    mounts = [
        (str(config.release_root / "releases"), "/usr/share/nginx"),
        (str(config.tool_root / "deploy/nginx-serving.conf"), "/etc/nginx/conf.d/default.conf"),
        (
            str(config.tool_root / "deploy/security-headers.conf"),
            "/etc/nginx/deploy/security-headers.conf",
        ),
    ]
    return {
        "name": "devhot-site",
        "services": {
            "nginx": {
                "image": NGINX_IMAGE,
                "container_name": "devhot-site-nginx",
                "user": "101:101",
                "read_only": True,
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "tmpfs": ["/tmp:rw,nosuid,noexec,size=64m,mode=1777"],
                "entrypoint": ["nginx"],
                "command": ["-g", "daemon off;"],
                "restart": "unless-stopped",
                "networks": ["service"],
                "labels": {"devhot.site.managed": "1"},
                "ports": [
                    {
                        "target": 8080,
                        "published": "80",
                        "host_ip": config.lan_ipv4,
                        "protocol": "tcp",
                    }
                ],
                "volumes": [
                    {
                        "type": "bind",
                        "source": source,
                        "target": target,
                        "read_only": True,
                        "bind": {"create_host_path": False},
                    }
                    for source, target in mounts
                ],
                "logging": {"driver": "journald", "options": {"tag": "devhot-site-nginx"}},
            }
        },
        "networks": {"service": {"internal": False, "labels": {"devhot.site.managed": "1"}}},
    }


def unit_files(config: HostConfig) -> dict[str, str]:
    executable = f"/usr/bin/python3 -E -s -B {config.tool_root}/deploy/host.py"
    return {
        "docker.service": daemon_unit(config),
        "devhot-site.service": f"""[Unit]
Description=Devhot static site deployment
ConditionUser=devhot-site
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart={executable} --config /etc/devhot-site/instance.json check-main
WorkingDirectory=/
RuntimeDirectory=devhot-site
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=XDG_RUNTIME_DIR=/run/user/{config.uid}
UMask=0077
TimeoutStartSec=7200
TimeoutStopSec=120
KillMode=control-group
StandardOutput=journal
StandardError=journal
SyslogIdentifier=devhot-site
""",
        "devhot-site.timer": """[Unit]
Description=Devhot daily deployment check (enable only after separate approval)
ConditionUser=devhot-site

[Timer]
OnCalendar=*-*-* 02:00:00 Asia/Shanghai
Persistent=true
Unit=devhot-site.service

[Install]
WantedBy=timers.target
""",
    }


def write_package(config: HostConfig, output: Path) -> None:
    import json

    output.mkdir(mode=0o700)
    units = output / "systemd/user"
    units.mkdir(parents=True, mode=0o700)
    for name, content in unit_files(config).items():
        path = units / name
        path.write_text(content)
        path.chmod(0o600)
    path = output / "compose.json"
    path.write_text(json.dumps(compose_plan(config), indent=2) + "\n")
    path.chmod(0o600)
