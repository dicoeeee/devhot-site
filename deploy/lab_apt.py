"""Explicit download routing inside a disposable Debian build container."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from release_store import DeploymentError


def configure(sources: Path, mirror: str | None) -> None:
    if mirror is None:
        return
    if mirror != "ustc":
        raise DeploymentError("deployment_invalid_debian_mirror")
    if sources.is_symlink() or not sources.is_file():
        raise DeploymentError("deployment_unexpected_apt_sources")
    replacements = {
        "http://deb.debian.org/debian": "https://mirrors.ustc.edu.cn/debian",
        "http://deb.debian.org/debian-security": "https://mirrors.ustc.edu.cn/debian-security",
    }
    lines, seen = [], set()
    for line in sources.read_text().splitlines(keepends=True):
        if line.startswith("URIs:"):
            uri = line.removeprefix("URIs:").strip()
            if uri not in replacements or uri in seen:
                raise DeploymentError("deployment_unexpected_apt_sources")
            seen.add(uri)
            line = "URIs: " + replacements[uri] + "\n"
        lines.append(line)
    if seen != set(replacements):
        raise DeploymentError("deployment_unexpected_apt_sources")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=sources.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.writelines(lines)
        temporary.chmod(sources.stat().st_mode & 0o777)
        temporary.replace(sources)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sources", type=Path, default=Path("/etc/apt/sources.list.d/debian.sources")
    )
    args = parser.parse_args()
    try:
        configure(args.sources, os.environ.get("DEVHOT_LAB_DEBIAN_MIRROR"))
    except DeploymentError as error:
        print(json.dumps({"status": "failed", "code": str(error)}))
        return 1
    except OSError:
        print(json.dumps({"status": "failed", "code": "deployment_apt_sources_unavailable"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
