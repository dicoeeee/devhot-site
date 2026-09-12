"""Anonymous fixed-repository acquisition and exact-tree export without Git metadata."""

from __future__ import annotations

import re
import shutil
from pathlib import Path, PurePosixPath

from deployment_controller import DeploymentFailure, PreparationUnavailable
from host_io import run
from release_store import DeploymentError, checked_sha

PUBLIC_REPOSITORY = "https://github.com/dicoeeee/devhot-site.git"
GIT = [
    "/usr/bin/git",
    "-c",
    "credential.helper=",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "http.followRedirects=false",
]


def network(arguments, environment, timeout):
    try:
        return run(arguments, environment, check=False, timeout=timeout)
    except DeploymentError as error:
        if str(error) == "deployment_command_timeout":
            raise PreparationUnavailable() from None
        raise


def main_sha(environment: dict) -> str:
    result = network(
        GIT + ["ls-remote", "--exit-code", PUBLIC_REPOSITORY, "refs/heads/main"], environment, 60
    )
    if result.returncode:
        raise PreparationUnavailable()
    if not re.fullmatch(r"[0-9a-f]{40}\trefs/heads/main\n", result.stdout):
        raise DeploymentFailure("input")
    return checked_sha(result.stdout.split()[0])


def fetch_main(bare: Path, sha: str, environment: dict) -> None:
    checked_sha(sha)
    run(GIT + ["init", "--bare", "--quiet", str(bare)], environment)
    result = network(
        GIT
        + [
            "--git-dir",
            str(bare),
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            PUBLIC_REPOSITORY,
            "refs/heads/main:refs/heads/main",
        ],
        environment,
        timeout=180,
    )
    if result.returncode:
        raise PreparationUnavailable()
    result = run(
        GIT + ["--git-dir", str(bare), "merge-base", "--is-ancestor", sha, "refs/heads/main"],
        environment,
        check=False,
    )
    if result.returncode:
        raise DeploymentFailure("input")


def export_tree(bare: Path, sha: str, output: Path, environment: dict) -> None:
    checked_sha(sha)
    # Inspect Git modes before archive: export-ignore attributes must not hide an
    # unsafe symlink/submodule. Read each blob directly so no attributes can
    # omit or transform source files (including lockfiles and gate definitions).
    result = run(
        GIT + ["--git-dir", str(bare), "ls-tree", "-rz", sha],
        environment,
        binary=True,
        limit=32 * 1024 * 1024,
    )
    entries = []
    for record in result.stdout.split(b"\0"):
        if not record:
            continue
        header, raw_path = record.split(b"\t", 1)
        mode, kind, blob = header.decode("ascii").split()
        try:
            name = raw_path.decode("utf-8")
        except UnicodeError:
            raise DeploymentFailure("input") from None
        path = PurePosixPath(name)
        if (
            mode not in ("100644", "100755")
            or kind != "blob"
            or path.is_absolute()
            or str(path) != name
            or any(part in (".", "..", ".git") for part in path.parts)
            or any(ord(character) < 32 for character in name)
        ):
            raise DeploymentFailure("input")
        entries.append((path, blob, mode))
    if not entries or len(entries) > 50000:
        raise DeploymentFailure("input")
    output.mkdir(mode=0o700)
    try:
        total = 0
        for relative, blob, mode in entries:
            data = run(
                GIT + ["--git-dir", str(bare), "cat-file", "blob", blob],
                environment,
                binary=True,
                limit=128 * 1024 * 1024,
            ).stdout
            total += len(data)
            if total > 512 * 1024 * 1024:
                raise DeploymentFailure("input")
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if mode == "100755" else 0o644)
    except BaseException:
        shutil.rmtree(output)
        raise
