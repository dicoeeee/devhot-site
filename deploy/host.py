"""Public deployment CLI. No fake-host switch, credential discovery or privilege escalation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from deployment_controller import DeploymentController
from deployment_state import unique_object
from host_builder import HostBuilder
from host_checks import assess_host, operator_identity
from host_commands import Events, HostCommands
from host_config import parse_config, write_package
from host_docker import RootlessDocker
from host_health import healthy
from host_io import read_root_json
from host_journal import JOURNAL_IO_ERROR, finish_events, journal_streams_ready, run_in_journal
from host_probe import HostProbe
from host_source import main_sha
from release_store import DeploymentError, ReleaseStore


def main(argv=None, *, require_journal=False):
    parser = argparse.ArgumentParser(description="Devhot Rootless host deployment")
    parser.add_argument("--config", type=Path, default=Path("/etc/devhot-site/instance.json"))
    commands = parser.add_subparsers(dest="command", required=True)
    render = commands.add_parser("render", help="generate new private installation material only")
    render.add_argument("--output", type=Path, required=True)
    for name in ("check", "serve", "check-main", "status", "recover", "cleanup"):
        commands.add_parser(name)
    for name in ("retry", "rollback"):
        commands.add_parser(name).add_argument("sha")
    args = parser.parse_args(argv)
    events = Events()
    journal_required = args.command not in ("render", "check", "status")
    try:
        if require_journal and not journal_required:
            raise DeploymentError("deployment_invalid_journal_worker")
        if args.command == "render":
            with args.config.open() as stream:
                config = parse_config(json.load(stream, object_pairs_hook=unique_object))
            write_package(config, args.output)
            events("render", None, "success")
            return 0
        if args.config != Path("/etc/devhot-site/instance.json"):
            raise DeploymentError("deployment_untrusted_configuration")
        config = parse_config(read_root_json(args.config, os.getgid()))
        if (os.getuid(), os.getgid()) != (config.uid, config.gid):
            raise DeploymentError("deployment_wrong_account")
        if journal_required:
            if not journal_streams_ready():
                if require_journal:
                    raise DeploymentError("deployment_journal_stream_unverified")
                return run_in_journal(Path(__file__), list(sys.argv[1:] if argv is None else argv))
            # Before HostProbe sets NNP, and before any state/lock/container mutation.
            events("journal", None, "started")
            if events.write_failed:
                return finish_events(events, JOURNAL_IO_ERROR)
        observations = HostProbe(config).collect()
        report = assess_host(config, observations, require_disabled_timer=args.command == "check")
        if args.command == "check":
            print(json.dumps(report))
            return 0 if report["status"] == "passed" else 1
        if report["status"] != "passed":
            if args.command == "status":
                report["rootlesskit"] = operator_identity(observations)
            print(json.dumps(report))
            if journal_required:
                events("check", None, "failed", "deployment_host_conditions_failed")
                return finish_events(events, 1)
            return 1
        store = ReleaseStore(config.release_root)
        docker = RootlessDocker(config)
        builder = HostBuilder(config, docker, events)
        controller = DeploymentController(
            store,
            config.state_root,
            config.runtime_root,
            prepare=builder.prepare,
            build=builder.build,
            health=lambda sha: healthy(config, store, sha),
            event=events,
        )
        app = HostCommands(
            controller, docker, builder, events, lambda: main_sha(docker.environment)
        )
        result = app.execute(args.command, getattr(args, "sha", None))
        if args.command == "status":
            result["rootlesskit"] = operator_identity(observations)
            result["service"] = {
                key: observations["deployment_service"].get(key)
                for key in ("LoadState", "ActiveState", "Result")
            }
            if (
                result["service"]["LoadState"] != "loaded"
                or result["service"]["ActiveState"] == "failed"
            ):
                result["status"] = "service_failed"
            print(json.dumps(result))
        code = 0 if result["status"] in ("success", "skipped", "uninitialized") else 1
        return finish_events(events, code) if journal_required else code
    except (DeploymentError, OSError, ValueError, TypeError) as error:
        code = str(error) if isinstance(error, DeploymentError) else "deployment_operation_failed"
        busy = code == "deployment_busy"
        events("busy" if busy else "operation", None, "skipped" if busy else "failed", code)
        code = 0 if busy and args.command == "check-main" else 1
        return finish_events(events, code) if journal_required else code


if __name__ == "__main__":
    sys.exit(main())
