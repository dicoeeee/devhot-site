"""Install only generated site units and Compose after administrator prerequisites."""

from __future__ import annotations

import argparse
import json
import os
import pwd
from pathlib import Path

from host_commands import Events
from host_config import compose_plan, parse_config, unit_files
from host_io import read_root_json, trusted
from release_store import DeploymentError


def installation_files(config):
    return {
        **{"/etc/systemd/user/" + name: content for name, content in unit_files(config).items()},
        "/etc/devhot-site/compose.json": json.dumps(compose_plan(config), indent=2) + "\n",
        "/etc/devhot-site/daemon.json": "{}\n",
    }


def inspect_installation(config):
    account = pwd.getpwnam(config.account)
    if (
        (account.pw_uid, account.pw_gid) != (config.uid, config.gid)
        or account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin", "/bin/false")
        or not trusted(config.tool_root / "deploy")
        or not all(trusted(path) for path in (config.tool_root / "deploy").rglob("*"))
    ):
        raise DeploymentError("deployment_install_prerequisites_failed")
    for target in installation_files(config):
        path = Path(target)
        if not trusted(path.parent) or os.path.lexists(path):
            raise DeploymentError("deployment_install_destination_not_empty")
    # Do not replace an existing user override or enabled timer from an older installation.
    for root in (Path("/etc/systemd/user"), Path(account.pw_dir) / ".config/systemd/user"):
        if root.is_dir():
            for path in root.rglob("*"):
                if path.name in ("docker.service", "devhot-site.service", "devhot-site.timer"):
                    raise DeploymentError("deployment_existing_user_units")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Inspect installation; --apply requires administrator approval"
    )
    parser.add_argument("--config", type=Path, default=Path("/etc/devhot-site/instance.json"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    events = Events()
    try:
        if args.apply and os.getuid() != 0:
            raise DeploymentError("deployment_install_requires_administrator")
        group = args.config.lstat().st_gid
        config = parse_config(read_root_json(args.config, group))
        if group != config.gid:
            raise DeploymentError("deployment_untrusted_configuration")
        inspect_installation(config)
        if args.apply:
            created = []
            try:
                for target, text in installation_files(config).items():
                    path = Path(target)
                    descriptor = os.open(
                        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
                    )
                    created.append(path)
                    with os.fdopen(descriptor, "w") as stream:
                        os.fchown(stream.fileno(), 0, config.gid if path.suffix == ".json" else 0)
                        os.fchmod(stream.fileno(), 0o640 if path.suffix == ".json" else 0o644)
                        stream.write(text)
                        stream.flush()
                        os.fsync(stream.fileno())
            except BaseException:
                for path in created:
                    path.unlink()
                raise
        events("install" if args.apply else "install_check", None, "success")
        return 0
    except (DeploymentError, OSError, ValueError, KeyError) as error:
        code = str(error) if isinstance(error, DeploymentError) else "deployment_install_failed"
        events("install", None, "failed", code)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
