"""Real journald/systemd-cat in an explicitly disposable Linux package container."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def verify_journal_entrypoint(config):
    if not Path("/.dockerenv").is_file() or os.environ.get("DEVHOT_PACKAGE_LAB") != "1":
        raise RuntimeError("deployment_package_lab_container_required")
    from host_journal import run_in_journal

    endpoint = Path("/run/systemd/journal/stdout")
    assert not endpoint.exists()
    host = config.tool_root / "deploy/host.py"
    worker = host.with_name("host_journal_worker.py")
    original = worker.read_bytes()
    marker = Path("/tmp/devhot-journal-worker-entered")
    fixture = (
        "import sys\nfrom pathlib import Path\n"
        "from host_journal import accept_worker\nfrom host_commands import Events\n"
        "if not accept_worker(int(sys.argv[1])): sys.exit(74)\n"
        f'Path({str(marker)!r}).write_text("entered")\n'
        'Events()("journal_test", "a"*40, "success")\nsys.exit(23)\n'
    )
    worker.write_text(fixture)
    daemon = None
    try:
        # No server: the real cat process cannot admit or execute the worker.
        assert run_in_journal(host, []) != 23
        assert not marker.exists()
        endpoint.parent.mkdir(parents=True, exist_ok=True)
        daemon = subprocess.Popen(
            ["/lib/systemd/systemd-journald"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/usr/sbin:/bin:/sbin", "SYSTEMD_LOG_LEVEL": "warning"},
        )
        for _ in range(100):
            if endpoint.exists():
                break
            assert daemon.poll() is None
            time.sleep(0.05)
        assert endpoint.exists()
        assert run_in_journal(host, []) == 23  # The normal worker status survives wrapping.
        assert marker.read_text() == "entered"

        def messages(pid=None):
            result = subprocess.run(
                [
                    "journalctl",
                    "--no-pager",
                    "--output=json",
                    "SYSLOG_IDENTIFIER=devhot-site",
                    *([f"_PID={pid}"] if pid is not None else []),
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=5,
            )
            return [json.loads(row)["MESSAGE"] for row in result.stdout.splitlines()]

        rows = []
        for _ in range(100):
            rows = messages()
            if any("journal_test" in row for row in rows):
                break
            time.sleep(0.05)
        event = next(json.loads(row) for row in rows if "journal_test" in row)
        assert event["sha"] == "a" * 40 and event["result"] == "success"
        assert set(event) == {"stage", "sha", "result", "duration_ms", "code"}
        marker.unlink()
        # A valid stdout alone is insufficient: redirecting stderr must block admission.
        worker.write_text(
            "import os,sys\nfrom pathlib import Path\n"
            "from host_journal import accept_worker\n"
            "fd=os.open(os.devnull,os.O_WRONLY);os.dup2(fd,2);os.close(fd)\n"
            "if not accept_worker(int(sys.argv[1])): sys.exit(74)\n"
            f"Path({str(marker)!r}).write_text('invalid-admission')\nsys.exit(23)\n"
        )
        assert run_in_journal(host, []) != 23
        assert not marker.exists()
        # A worker that never acknowledges must be stopped within the startup bound.
        worker.write_text(
            "import time\nfrom pathlib import Path\ntime.sleep(30)\n"
            f"Path({str(marker)!r}).write_text('late-admission')\n"
        )
        started = time.monotonic()
        assert run_in_journal(host, []) != 0
        assert time.monotonic() - started < 10
        assert not marker.exists()
        worker.write_bytes(original)

        # Execute the installed public manual command as its real non-login UID.
        # This fixture deliberately lacks a Rootless daemon, so readiness fails;
        # its journal admission/check-failure events must still be queryable.
        operation = subprocess.run(
            [
                "runuser",
                "-u",
                config.account,
                "--",
                "/usr/bin/python3",
                "-E",
                "-s",
                "-B",
                str(host),
                "check-main",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert operation.returncode == 1
        for _ in range(100):
            rows = messages()
            if any("deployment_host_conditions_failed" in row for row in rows):
                break
            time.sleep(0.05)
        assert any("deployment_host_conditions_failed" in row for row in rows)
        assert not (config.state_root / "deployment.json").exists()
        assert not (config.release_root / "releases/current").exists()

        # Read-only/material commands remain on their caller's output stream.
        readonly = subprocess.Popen(
            [sys.executable, "-B", str(host), "render", "--output", "/tmp/devhot-journal-render"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = readonly.communicate(timeout=10)
        assert readonly.returncode == 0, stderr
        assert json.loads(stdout)["stage"] == "render"
        assert messages(readonly.pid) == []
    finally:
        worker.write_bytes(original)
        if daemon is not None:
            daemon.terminate()
            try:
                daemon.wait(timeout=5)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()
