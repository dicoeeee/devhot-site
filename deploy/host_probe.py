"""Read-only Linux observations. Missing permissions remain explicit failed checks."""

from __future__ import annotations

import grp
import hashlib
import json
import os
import platform
import pwd
import re
import time
from pathlib import Path

from host_config import HostConfig, unit_files
from host_daemon import (
    daemon_argv,
    effective_start_matches,
    namespace_map_matches,
    process_children,
    process_identity,
    trusted_launch_files,
)
from host_io import (
    command_environment,
    enforce_no_new_privileges,
    metadata,
    read_root_json,
    run,
    secure_directory_ancestors,
    trusted,
)
from host_sockets import protected_ipc_socket, socket_policy
from release_store import DeploymentError


def sudo_denied(result):
    output = result.stdout + result.stderr
    if result.returncode != 1 or any(
        message in output.lower()
        for message in (
            "password is required",
            "authentication",
            "no new privileges",
            "effective uid",
        )
    ):
        return False
    patterns = (
        r"Sorry, user devhot-site may not run sudo on [A-Za-z0-9._-]+\.",
        r"User devhot-site is not allowed to run sudo on [A-Za-z0-9._-]+\.",
        r"devhot-site is not in the sudoers file\..*",
    )
    return any(
        re.fullmatch(pattern, line.strip()) for line in output.splitlines() for pattern in patterns
    )


def subids(path: Path, account: str, identity: int) -> list:
    rows = []
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        name, start, count = line.split(":")
        rows.append((name, int(start), int(count)))
    chosen = [(s, n) for name, s, n in rows if name in (account, str(identity))]
    for start, count in chosen:
        if any(
            max(start, other) < min(start + count, other + size)
            for name, other, size in rows
            if name not in (account, str(identity))
        ):
            return []
    return chosen


class HostProbe:
    def __init__(self, config: HostConfig):
        self.config = config
        self.environment = command_environment(config.uid)

    def command(self, *arguments, check=True):
        return run(list(arguments), self.environment, check=check)

    def service(self, name):
        result = self.command(
            "/usr/bin/systemctl",
            "--user",
            "show",
            name,
            "--property=LoadState,ActiveState,UnitFileState,MainPID,Result,FragmentPath,DropInPaths,ExecStart,EnvironmentFiles,RootDirectory,RootImage,ExecMainStartTimestampMonotonic",
        )
        return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)

    def daemon_identity(self, pid: int) -> dict:
        config = self.config
        path = Path(config.rootlesskit.path)
        value = metadata(path)
        proc = Path("/proc") / str(pid)
        before = process_identity(proc)
        service = self.service("docker.service")
        unit = Path("/etc/systemd/user/docker.service")
        launch_valid = (
            trusted(unit)
            and unit.read_text() == unit_files(config)["docker.service"]
            and service.get("FragmentPath") == str(unit)
            and service.get("DropInPaths") == ""
            and service.get("EnvironmentFiles") == ""
            and service.get("RootDirectory") == ""
            and service.get("RootImage") == ""
            and effective_start_matches(config, service.get("ExecStart", ""))
            and trusted_launch_files(config)
            and read_root_json(Path("/etc/devhot-site/daemon.json"), config.gid) == {}
            and before["argv"][0] in (str(path), "rootlesskit")
            and before["argv"][-3:] == daemon_argv(config)[-3:]
        )
        capabilities = self.command("/usr/sbin/getcap", str(path)).stdout.strip().split()
        started = time.time_ns() - int(
            (
                time.clock_gettime(time.CLOCK_BOOTTIME)
                - before["start_ticks"] / os.sysconf("SC_CLK_TCK")
            )
            * 1_000_000_000
        )
        files = (
            path,
            unit,
            Path("/usr/bin/dockerd-rootless.sh"),
            Path("/usr/bin/env"),
            Path("/bin/sh").resolve(),
            Path("/etc/devhot-site/daemon.json"),
        )
        after = process_identity(proc)
        latest = self.service("docker.service")
        value.update(
            path=str(path),
            sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            trusted_parents=trusted(path),
            capabilities=" ".join(capabilities[1:]),
            process_uid=before["uid"],
            process_cap_effective=before["cap_effective"],
            process_cap_permitted=before["cap_permitted"],
            process_start_ticks=before["start_ticks"],
            proof="trusted_launch_chain",
            launch_chain_valid=launch_valid,
            started_after_files=all(file.stat().st_ctime_ns <= started for file in files),
            pid_stable=(
                before == after
                and int(latest["MainPID"]) == pid
                and service["ExecMainStartTimestampMonotonic"]
                == latest["ExecMainStartTimestampMonotonic"]
            ),
        )
        return value

    def daemon_sockets(self, pid: int) -> bool:
        # Traverse only the confirmed user service subtree; never process environments.
        pending, seen, daemons = [pid], set(), []
        while pending:
            current = pending.pop()
            if current in seen or len(seen) > 4096:
                return False
            seen.add(current)
            proc = Path("/proc") / str(current)
            if (proc / "comm").read_text().strip() == "dockerd":
                executable = Path(os.readlink(proc / "exe"))
                if (
                    process_identity(proc)["uid"] != self.config.uid
                    or executable.name != "dockerd"
                    or not trusted(executable, executable=True)
                ):
                    return False
                daemons.append(proc)
                continue  # Docker container processes are not daemon API listeners.
            pending.extend(process_children(proc) - seen)
        if len(daemons) != 1:
            return False
        proc = self.daemon_proc = daemons[0]
        owned = set()
        for path in (proc / "fd").iterdir():
            target = os.readlink(path)
            if target.startswith("socket:[") and target.endswith("]"):
                owned.add(target[8:-1])
        return socket_policy(
            owned,
            [(proc / "net" / name).read_text() for name in ("tcp", "tcp6")],
            (proc / "net/unix").read_text(),
            str(self.config.socket),
            internal_socket_check=lambda path: protected_ipc_socket(
                proc / "root", path, self.config.uid, self.config.gid
            ),
        )

    def collect(self) -> dict:
        config = self.config
        result = {"platform": platform.system().lower(), "uid": os.getuid(), "gid": os.getgid()}

        def observe(key, callback):
            try:
                result[key] = callback()
            except (OSError, KeyError, ValueError, TypeError, AttributeError, DeploymentError):
                result[key] = None

        def account():
            value = pwd.getpwnam(config.account)
            return dict(uid=value.pw_uid, gid=value.pw_gid, shell=value.pw_shell)

        observe("account", account)
        if result["platform"] != "linux" or (result["uid"], result["gid"]) != (
            config.uid,
            config.gid,
        ):
            return result
        observe(
            "groups",
            lambda: [grp.getgrgid(gid).gr_name for gid in set(os.getgroups() + [os.getgid()])],
        )
        observe(
            "rootful_socket_access",
            lambda: any(
                os.access(path, os.R_OK | os.W_OK)
                for path in ("/run/docker.sock", "/var/run/docker.sock")
            ),
        )

        observe("group_ids", lambda: sorted(set(os.getgroups() + [os.getgid()])))

        def sudo_policy():
            executable = Path("/usr/bin/sudo")
            if not executable.exists():
                return "unverified"
            response = self.command(str(executable), "-n", "-l", check=False)
            return "denied" if sudo_denied(response) else "unverified"

        observe("sudo_policy", sudo_policy)
        if result.get("sudo_policy") != "denied":
            return result
        observe("no_new_privileges", enforce_no_new_privileges)
        if result.get("no_new_privileges") is not True:
            return result

        observe("subuid", lambda: subids(Path("/etc/subuid"), config.account, config.uid))
        observe("subgid", lambda: subids(Path("/etc/subgid"), config.account, config.uid))
        observe(
            "mapping_helpers",
            lambda: all(
                trusted(Path("/usr/bin") / name, executable=True)
                and metadata(Path("/usr/bin") / name)["mode"] == 0o4755
                for name in ("newuidmap", "newgidmap")
            ),
        )
        observe(
            "cgroup_controllers",
            lambda: Path("/sys/fs/cgroup/cgroup.controllers").read_text().split(),
        )
        directories = {
            "release_root": config.release_root,
            "candidates": config.release_root / "candidates",
            "releases": config.release_root / "releases",
            "versions": config.release_root / "releases/versions",
            "state_root": config.state_root,
            "daemon_home": config.state_root / "daemon-home",
            "runtime_root": config.runtime_root,
            "tool_root": config.tool_root,
        }
        result["directories"] = {}
        for key, path in directories.items():
            try:
                result["directories"][key] = {
                    **metadata(path),
                    "secure_ancestors": secure_directory_ancestors(path, config.uid),
                }
            except OSError:
                result["directories"][key] = {}
        observe(
            "installed_tools_trusted",
            lambda: (
                trusted(config.tool_root / "deploy")
                and all(trusted(path) for path in (config.tool_root / "deploy").rglob("*"))
            ),
        )
        client = Path("/etc/devhot-site/docker-client")
        observe(
            "empty_docker_config",
            lambda: trusted(client) and client.is_dir() and not any(client.iterdir()),
        )
        observe(
            "lan_addresses",
            lambda: [
                entry["local"]
                for row in json.loads(
                    self.command(
                        "/usr/sbin/ip", "-j", "-4", "address", "show", "to", config.lan_ipv4 + "/32"
                    ).stdout
                )
                for entry in row["addr_info"]
            ],
        )
        observe("timer", lambda: self.service("devhot-site.timer"))
        observe("deployment_service", lambda: self.service("devhot-site.service"))

        def units_match():
            for name, content in unit_files(config).items():
                path = Path("/etc/systemd/user") / name
                observed = self.service(name)
                if (
                    not trusted(path)
                    or path.read_text() != content
                    or observed.get("FragmentPath") != str(path)
                    or observed.get("DropInPaths") != ""
                ):
                    return False
            return True

        observe("site_units", units_match)

        def compose_plugin():
            paths = [
                Path(prefix) / "docker/cli-plugins/docker-compose"
                for prefix in ("/usr/local/lib", "/usr/local/libexec", "/usr/lib", "/usr/libexec")
            ]
            found = [path for path in paths if os.path.lexists(path)]
            return bool(found) and all(
                trusted(path.resolve(), executable=True) and trusted(path.parent) for path in found
            )

        observe("compose_plugin", compose_plugin)

        observe("daemon_service", lambda: self.service("docker.service"))
        observe("socket", lambda: metadata(config.socket))
        observe(
            "rootlesskit", lambda: self.daemon_identity(int(result["daemon_service"]["MainPID"]))
        )
        observe(
            "daemon_unix_only",
            lambda: self.daemon_sockets(int(result["daemon_service"]["MainPID"])),
        )
        observe(
            "user_namespace",
            lambda: (
                namespace_map_matches(
                    (self.daemon_proc / "uid_map").read_text(), config.uid, result["subuid"]
                )
                and namespace_map_matches(
                    (self.daemon_proc / "gid_map").read_text(), config.gid, result["subgid"]
                )
            ),
        )
        socket = result.get("socket") or {}
        identity = result.get("rootlesskit") or {}
        # Do not contact a rootful or unverified endpoint merely to inspect its info.
        if (
            socket.get("canonical") is True
            and socket.get("kind") == "socket"
            and socket.get("uid") == config.uid
            and socket.get("mode") in (0o600, 0o660)
            and identity.get("launch_chain_valid") is True
            and identity.get("pid_stable") is True
            and identity.get("started_after_files") is True
            and result.get("empty_docker_config") is True
        ):
            observe(
                "docker",
                lambda: json.loads(
                    self.command(
                        "/usr/bin/docker",
                        "--host",
                        "unix://" + str(config.socket),
                        "info",
                        "--format",
                        "{{json .}}",
                    ).stdout
                ),
            )
        return result
