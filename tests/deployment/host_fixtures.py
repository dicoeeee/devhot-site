"""Synthetic OS observations, never evidence of a real Rootless host."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_host_package import instance


def healthy_host():
    result = {
        "platform": "linux",
        "uid": 1001,
        "gid": 1001,
        "account": {"uid": 1001, "gid": 1001, "shell": "/usr/sbin/nologin"},
        "groups": ["devhot-site"],
        "group_ids": [1001],
        "sudo_policy": "denied",
        "no_new_privileges": True,
        "rootful_socket_access": False,
        "daemon_unix_only": True,
        "subuid": [(231072, 65536)],
        "subgid": [(231072, 65536)],
        "mapping_helpers": True,
        "user_namespace": True,
        "cgroup_controllers": ["memory", "pids"],
        "docker": {
            "OSType": "linux",
            "Architecture": "aarch64",
            "CgroupVersion": "2",
            "CgroupDriver": "systemd",
            "SecurityOptions": ["name=rootless", "name=seccomp,profile=builtin"],
            "MemoryLimit": True,
            "PidsLimit": True,
            "Plugins": {"Log": ["journald"]},
        },
        "socket": {"uid": 1001, "gid": 1001, "mode": 0o660, "kind": "socket", "canonical": True},
        "rootlesskit": {
            **instance()["rootlesskit"],
            "uid": 0,
            "mode": 0o755,
            "kind": "file",
            "canonical": True,
            "trusted_parents": True,
            "capabilities": "cap_net_bind_service=ep",
            "process_uid": 1001,
            "process_cap_effective": 1 << 10,
            "process_cap_permitted": 1 << 10,
            "proof": "trusted_launch_chain",
            "launch_chain_valid": True,
            "started_after_files": True,
            "pid_stable": True,
            "process_start_ticks": 100,
        },
        "directories": {
            "daemon_home": {
                "uid": 1001,
                "gid": 1001,
                "mode": 0o700,
                "kind": "directory",
                "canonical": True,
                "device": 2,
            },
            "release_root": {
                "uid": 1001,
                "gid": 1001,
                "mode": 0o750,
                "kind": "directory",
                "canonical": True,
                "device": 2,
            },
            "candidates": {
                "uid": 1001,
                "gid": 1001,
                "mode": 0o700,
                "kind": "directory",
                "canonical": True,
                "device": 2,
            },
            "releases": {
                "uid": 1001,
                "gid": 1001,
                "mode": 0o755,
                "kind": "directory",
                "canonical": True,
                "device": 2,
            },
            "versions": {
                "uid": 1001,
                "gid": 1001,
                "mode": 0o755,
                "kind": "directory",
                "canonical": True,
                "device": 2,
            },
            "state_root": {
                "uid": 1001,
                "gid": 1001,
                "mode": 0o700,
                "kind": "directory",
                "canonical": True,
                "device": 2,
            },
            "runtime_root": {
                "uid": 1001,
                "gid": 1001,
                "mode": 0o700,
                "kind": "directory",
                "canonical": True,
                "device": 3,
            },
            "tool_root": {
                "uid": 0,
                "gid": 0,
                "mode": 0o755,
                "kind": "directory",
                "canonical": True,
                "device": 2,
            },
        },
        "installed_tools_trusted": True,
        "empty_docker_config": True,
        "site_units": True,
        "compose_plugin": True,
        "lan_addresses": ["192.168.50.10"],
        "daemon_service": {"LoadState": "loaded", "ActiveState": "active", "MainPID": "123"},
        "timer": {"LoadState": "loaded", "ActiveState": "inactive", "UnitFileState": "disabled"},
        "deployment_service": {
            "LoadState": "loaded",
            "ActiveState": "inactive",
            "Result": "success",
        },
    }
    for directory in result["directories"].values():
        directory["secure_ancestors"] = True
    return result
