"""Explicit container-only installation experiment; never run on a deployment host."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "deploy"))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def verify_socket_observation(config):
    from host_sockets import protected_ipc_socket, socket_policy

    runtime = Path("/run/user") / str(config.uid)
    ipc = runtime / "docker/libnetwork/0123456789ab.sock"
    ipc.parent.mkdir(parents=True)
    runtime.chmod(0o700)
    os.chown(runtime, config.uid, config.gid)
    listeners = []
    try:
        for path in (runtime / "docker.sock", ipc):
            listener = socket.socket(socket.AF_UNIX)
            listeners.append(listener)
            listener.bind(str(path))
            listener.listen()
            path.chmod(0o600)
            os.chown(path, config.uid, config.gid)

        def observed():
            owned = {os.readlink(f"/proc/self/fd/{item.fileno()}")[8:-1] for item in listeners}
            return socket_policy(
                owned,
                [Path(f"/proc/self/net/{name}").read_text() for name in ("tcp", "tcp6")],
                Path("/proc/self/net/unix").read_text(),
                str(runtime / "docker.sock"),
                internal_socket_check=lambda path: protected_ipc_socket(
                    Path("/proc/self/root"), path, config.uid, config.gid
                ),
            )

        assert observed()  # Actual listener descriptor inodes and kernel tables, not mock counts.
        ipc.chmod(0o660)
        assert not observed()
        ipc.chmod(0o600)
        assert observed()
        other = socket.socket(socket.AF_UNIX)
        listeners.append(other)
        other.bind(str(runtime / "unknown.sock"))
        other.listen()
        assert not observed()
        listeners.pop().close()
        assert observed()
        for family, address in ((socket.AF_INET, ("127.0.0.1", 0)), (socket.AF_INET6, ("::1", 0))):
            with socket.socket(family) as tcp:
                tcp.bind(address)
                tcp.listen()
                listeners.append(tcp)
                assert not observed()
                listeners.pop()
        assert observed()
    finally:
        for listener in listeners:
            listener.close()
        shutil.rmtree(runtime)


def main():
    # Require Docker's container marker and a lab-only invocation flag; this
    # script makes synthetic account/files inside the disposable build container.
    if not Path("/.dockerenv").is_file() or os.environ.get("DEVHOT_PACKAGE_LAB") != "1":
        raise RuntimeError("deployment_package_lab_container_required")
    import host_config
    import test_host_package

    value = test_host_package.instance()
    config = host_config.parse_config(value)
    subprocess.run(["groupadd", "--gid", str(config.gid), config.account], check=True)
    subprocess.run(
        [
            "useradd",
            "--uid",
            str(config.uid),
            "--gid",
            str(config.gid),
            "--no-create-home",
            "--home-dir",
            "/nonexistent",
            "--shell",
            "/usr/sbin/nologin",
            config.account,
        ],
        check=True,
    )
    verify_socket_observation(config)
    config.tool_root.mkdir(mode=0o755)
    shutil.copytree(
        PROJECT / "deploy",
        config.tool_root / "deploy",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    for path in (config.tool_root / "deploy").rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)
    local = Path("/etc/devhot-site")
    local.mkdir(mode=0o750)
    os.chown(local, 0, config.gid)
    path = local / "instance.json"
    path.write_text(json.dumps(value))
    path.chmod(0o640)
    os.chown(path, 0, config.gid)
    installer = [sys.executable, "-E", "-s", "-B", str(config.tool_root / "deploy/host_install.py")]
    subprocess.run(installer, check=True)
    assert not (local / "compose.json").exists()
    assert not Path("/etc/systemd/user/devhot-site.timer").exists()
    subprocess.run(installer + ["--apply"], check=True)
    for name, expected in host_config.unit_files(config).items():
        installed = Path("/etc/systemd/user") / name
        assert installed.read_text() == expected
        assert installed.stat().st_uid == 0 and installed.stat().st_mode & 0o777 == 0o644
    compose = local / "compose.json"
    assert json.loads(compose.read_text()) == host_config.compose_plan(config)
    assert compose.stat().st_uid == 0 and compose.stat().st_gid == config.gid
    assert compose.stat().st_mode & 0o777 == 0o640
    from host_docker import RootlessDocker
    from release_store import DeploymentError

    docker = RootlessDocker(config)
    assert docker.checked_compose() == compose
    safe = compose.read_text()
    invalid = json.loads(safe)
    invalid["services"]["nginx"]["ports"][0]["host_ip"] = "0.0.0.0"
    compose.write_text(json.dumps(invalid))
    try:
        docker.checked_compose()
    except DeploymentError as error:
        assert str(error) == "deployment_compose_configuration_mismatch"
    else:
        raise AssertionError("unsafe installed configuration accepted")
    compose.write_text(safe)
    assert docker.checked_compose() == compose

    disabled = subprocess.run(
        ["systemctl", "--global", "is-enabled", "devhot-site.timer"], capture_output=True, text=True
    )
    assert disabled.returncode == 1 and disabled.stdout.strip() == "disabled"
    assert not any(
        path.is_symlink() and path.name.startswith("devhot-site.")
        for path in Path("/etc/systemd/user").rglob("*")
    )
    before = {
        name: Path(name).read_bytes()
        for name in [
            "/etc/systemd/user/devhot-site.service",
            "/etc/systemd/user/devhot-site.timer",
            str(compose),
        ]
    }
    assert subprocess.run(installer + ["--apply"], capture_output=True).returncode != 0
    assert before == {name: Path(name).read_bytes() for name in before}
    syntax = Path("/tmp/devhot-package-syntax")
    syntax.mkdir()
    for name, content in host_config.unit_files(config).items():
        (syntax / name).write_text(content)
    subprocess.run(
        ["systemd-analyze", "verify", "--man=no", *map(str, syntax.iterdir())], check=True
    )
    calendar = subprocess.run(
        ["systemd-analyze", "calendar", "*-*-* 02:00:00 Asia/Shanghai"],
        env={**os.environ, "TZ": "America/New_York"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert "02:00:00 Asia/Shanghai" in calendar.stdout
    assert "18:00:00 UTC" in calendar.stdout
    (syntax / "devhot-site.timer").write_text("[Timer]\nOnCalendar=invalid-time\n")
    assert (
        subprocess.run(
            ["systemd-analyze", "verify", "--man=no", str(syntax / "devhot-site.timer")],
            capture_output=True,
        ).returncode
        != 0
    )
    hardened = subprocess.run(
        [
            sys.executable,
            "-B",
            "-c",
            "import sys;sys.path.insert(0," + repr(str(config.tool_root / "deploy")) + ");"
            "from host_io import enforce_no_new_privileges;"
            "assert enforce_no_new_privileges();"
            "print(next(line for line in open('/proc/self/status') "
            "if line.startswith('NoNewPrivs:')).strip())",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert hardened.stdout.split() == ["NoNewPrivs:", "1"]
    from verify_linux_journal import verify_journal_entrypoint

    verify_journal_entrypoint(config)
    print(
        json.dumps(
            dict(
                status="passed",
                scope="disposable_container_package",
                install_readonly=True,
                timer_disabled=True,
                no_enabled_links=True,
                existing_install_preserved=True,
                unit_syntax=True,
                explicit_timezone=True,
                invalid_calendar_rejected=True,
                no_new_privileges_observed=True,
                installed_compose_revalidated=True,
                actual_proc_socket_positive_negative=True,
                actual_journald_readback=True,
                real_rootless_host=False,
            )
        )
    )


if __name__ == "__main__":
    main()
