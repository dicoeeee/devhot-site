"""Create two real, isolated Git versions from the reviewed public working tree."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from release_store import DeploymentError, checked_sha


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Devhot Lab",
            "-c",
            "user.email=lab@example.invalid",
            "-C",
            str(root),
            *args,
        ],
        capture_output=True,
        check=True,
        timeout=60,
        env={
            **{key: value for key, value in os.environ.items() if not key.startswith("GIT_")},
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        },
    )
    # NUL-delimited Git paths must retain whitespace and literal CR bytes.
    # Decode as filesystem names without universal-newline conversion.
    return os.fsdecode(result.stdout)


class SourceFixture:
    def __init__(self, project: Path, root: Path):
        self.project, self.root = project, root
        root.mkdir()
        # Git's index is the public-source boundary. New reviewed files can be
        # included with intent-to-add; unrelated untracked files are never read.
        paths = git(project, "ls-files", "--cached", "-z").split("\0")
        for relative in sorted(set(filter(None, paths))):
            if ".." in Path(relative).parts or Path(relative).is_absolute():
                raise DeploymentError("deployment_unsafe_source")
            checked = project
            for part in Path(relative).parts:
                checked = checked / part
                if checked.is_symlink():
                    raise DeploymentError("deployment_unsafe_source")
            source = project / relative
            if not source.exists():
                continue
            if not source.is_file():
                raise DeploymentError("deployment_unsafe_source")
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        git(root, "init", "--quiet", "-b", "main")
        git(root, "add", ".")
        git(root, "commit", "--quiet", "-m", "isolated public lab baseline")
        self.home = json.loads((root / "site-input/data/home.json").read_text())

    def version(self, marker: str) -> str:
        baseline = checked_sha(git(self.root, "rev-parse", "HEAD").strip())
        home = json.loads(json.dumps(self.home))
        if home.get("schemaVersion") != 2:
            raise DeploymentError("deployment_lab_requires_current_input")
        for domain in home["domains"]:
            domain["weeklyFocus"]["overview"] += "\n\n本地部署验收 " + marker + "。"
        path = self.root / "site-input/data/home.json"
        path.write_text(json.dumps(home, ensure_ascii=False, indent=2) + "\n")
        self.format_json(path)
        manifest_path = self.root / "site-input/manifest.json"
        manifest = json.loads(manifest_path.read_text())
        for entry in manifest["files"]:
            entry["sha256"] = hashlib.sha256(
                (self.root / "site-input" / entry["path"]).read_bytes()
            ).hexdigest()
        identity_input = {
            "schemaVersion": 2,
            "baselineSha": baseline,
            "entrypoints": manifest["entrypoints"],
            "files": manifest["files"],
        }
        identity = hashlib.sha256(
            json.dumps(
                identity_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
        manifest["candidate"] = {"baselineSha": baseline, "inputIdentity": identity}
        manifest["publicationId"] = "candidate-" + identity[:24]
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        self.format_json(manifest_path)
        git(self.root, "add", "site-input")
        git(self.root, "commit", "--quiet", "-m", "isolated lab version " + marker)
        return checked_sha(git(self.root, "rev-parse", "HEAD").strip())

    def format_json(self, path: Path) -> None:
        subprocess.run(
            [
                "node",
                str(self.project / "node_modules/prettier/bin/prettier.cjs"),
                "--write",
                str(path),
            ],
            cwd=self.project,
            capture_output=True,
            check=True,
            timeout=60,
        )

    def export(self, target: Path) -> None:
        target.mkdir()
        for relative in git(self.root, "ls-files", "-z").split("\0"):
            if not relative:
                continue
            source = self.root / relative
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
