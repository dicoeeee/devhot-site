"""Readiness policy over explicit, read-only operating-system observations."""

from __future__ import annotations

from host_config import HostConfig
from host_daemon import subordinate_ranges_safe

REAL_HOST_ACCEPTANCE = [
    "user_authorization",
    "firewall_and_client_access",
    "private_data_inaccessibility",
    "restart_recovery",
    "scheduled_execution_and_journald",
    "github_publication_governance",
]


def assess_host(config: HostConfig, evidence: dict, *, require_disabled_timer: bool = True) -> dict:
    checks = []

    def require(name, predicate):
        try:
            passed = predicate() is True
        except (KeyError, TypeError, ValueError, AttributeError):
            passed = False
        checks.append(
            {
                "id": name,
                "status": "passed" if passed else "failed",
                "code": None if passed else "deployment_host_" + name + "_failed",
            }
        )

    require("linux", lambda: evidence["platform"] == "linux")
    require(
        "account",
        lambda: (
            evidence["uid"] == config.uid
            and evidence["gid"] == config.gid
            and evidence["account"]["uid"] == config.uid
            and evidence["account"]["gid"] == config.gid
            and evidence["account"]["shell"] in ("/usr/sbin/nologin", "/sbin/nologin", "/bin/false")
        ),
    )
    require(
        "groups",
        lambda: evidence["groups"] == ["devhot-site"] and evidence["group_ids"] == [config.gid],
    )
    require("no_new_privileges", lambda: evidence["no_new_privileges"] is True)
    require("sudo", lambda: evidence["sudo_policy"] == "denied")
    require("daemon_unix_only", lambda: evidence["daemon_unix_only"] is True)
    require("rootful_socket", lambda: evidence["rootful_socket_access"] is False)
    for key in ("subuid", "subgid"):
        require(
            key,
            lambda key=key: subordinate_ranges_safe(
                evidence[key], config.uid if key == "subuid" else config.gid
            ),
        )
    require("mapping_helpers", lambda: evidence["mapping_helpers"] is True)
    require("user_namespace", lambda: evidence["user_namespace"] is True)
    require(
        "cgroup",
        lambda: (
            {"memory", "pids"}.issubset(evidence["cgroup_controllers"])
            and evidence["docker"]["CgroupVersion"] == "2"
            and evidence["docker"]["CgroupDriver"] == "systemd"
            and evidence["docker"]["MemoryLimit"] is True
            and evidence["docker"]["PidsLimit"] is True
        ),
    )
    require(
        "rootless_daemon",
        lambda: (
            evidence["docker"]["OSType"] == "linux"
            and evidence["docker"]["Architecture"] in ("aarch64", "arm64", "x86_64", "amd64")
            and "name=rootless" in evidence["docker"]["SecurityOptions"]
            and "journald" in evidence["docker"]["Plugins"]["Log"]
            and evidence["daemon_service"]["LoadState"] == "loaded"
            and evidence["daemon_service"]["ActiveState"] == "active"
            and int(evidence["daemon_service"]["MainPID"]) > 1
        ),
    )
    require(
        "socket",
        lambda: (
            evidence["socket"]["canonical"] is True
            and evidence["socket"]["kind"] == "socket"
            and evidence["socket"]["uid"] == config.uid
            and evidence["socket"]["gid"] == config.gid
            and evidence["socket"]["mode"] in (0o600, 0o660)
        ),
    )
    identity = config.rootlesskit
    require(
        "rootlesskit",
        lambda: (
            evidence["rootlesskit"]["canonical"] is True
            and evidence["rootlesskit"]["trusted_parents"] is True
            and evidence["rootlesskit"]["path"] == identity.path
            and evidence["rootlesskit"]["sha256"] == identity.sha256
            and evidence["rootlesskit"]["device"] == identity.device
            and evidence["rootlesskit"]["inode"] == identity.inode
            and evidence["rootlesskit"]["uid"] == 0
            and evidence["rootlesskit"]["kind"] == "file"
            and evidence["rootlesskit"]["mode"] & 0o7022 == 0
            and evidence["rootlesskit"]["mode"] & 0o111 != 0
            and evidence["rootlesskit"]["capabilities"] == "cap_net_bind_service=ep"
            and evidence["rootlesskit"]["process_uid"] == config.uid
            and evidence["rootlesskit"]["process_cap_effective"] == 1 << 10
            and evidence["rootlesskit"]["process_cap_permitted"] == 1 << 10
            and evidence["rootlesskit"]["proof"] == "trusted_launch_chain"
            and evidence["rootlesskit"]["launch_chain_valid"] is True
            and evidence["rootlesskit"]["started_after_files"] is True
            and evidence["rootlesskit"]["pid_stable"] is True
            and evidence["rootlesskit"]["process_start_ticks"] > 0
        ),
    )
    modes = {
        "release_root": 0o750,
        "candidates": 0o700,
        "releases": 0o755,
        "versions": 0o755,
        "state_root": 0o700,
        "daemon_home": 0o700,
        "runtime_root": 0o700,
        "tool_root": 0o755,
    }
    for key, mode in modes.items():
        require(
            key,
            lambda key=key, mode=mode: (
                evidence["directories"][key]["kind"] == "directory"
                and evidence["directories"][key]["canonical"] is True
                and evidence["directories"][key]["secure_ancestors"] is True
                and evidence["directories"][key]["uid"] == (0 if key == "tool_root" else config.uid)
                and evidence["directories"][key]["gid"] == (0 if key == "tool_root" else config.gid)
                and evidence["directories"][key]["mode"] == mode
            ),
        )
    require(
        "same_filesystem",
        lambda: (
            len(
                {
                    evidence["directories"][key]["device"]
                    for key in ("release_root", "candidates", "releases", "versions")
                }
            )
            == 1
        ),
    )
    require("installed_tools", lambda: evidence["installed_tools_trusted"] is True)
    require("compose_plugin", lambda: evidence["compose_plugin"] is True)
    require("site_units", lambda: evidence["site_units"] is True)
    require("docker_client", lambda: evidence["empty_docker_config"] is True)
    require("lan_address", lambda: config.lan_ipv4 in evidence["lan_addresses"])
    if require_disabled_timer:
        require(
            "timer_disabled",
            lambda: (
                evidence["timer"]["ActiveState"] == "inactive"
                and (
                    (
                        evidence["timer"]["LoadState"] == "loaded"
                        and evidence["timer"]["UnitFileState"] == "disabled"
                    )
                    or evidence["timer"]["LoadState"] == "not-found"
                )
            ),
        )
    return {
        "schemaVersion": 1,
        "status": "passed" if all(c["status"] == "passed" for c in checks) else "failed",
        "checks": checks,
        "requires_real_host_acceptance": REAL_HOST_ACCEPTANCE.copy(),
    }


def operator_identity(evidence: dict) -> dict:
    """Necessary binary identity for private status; never a public projection."""
    identity = evidence.get("rootlesskit")
    if not isinstance(identity, dict):
        return {"status": "unavailable"}
    fields = (
        "path",
        "kind",
        "uid",
        "gid",
        "mode",
        "sha256",
        "device",
        "inode",
        "capabilities",
        "proof",
        "launch_chain_valid",
        "process_uid",
        "process_start_ticks",
        "process_cap_effective",
        "process_cap_permitted",
        "pid_stable",
        "started_after_files",
    )
    return {"status": "observed", **{key: identity[key] for key in fields if key in identity}}
