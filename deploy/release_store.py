"""Private candidate storage and atomic activation of complete static releases."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from pathlib import Path, PurePosixPath


class DeploymentError(ValueError):
    """A fixed diagnostic code, never an environment or command dump."""


def checked_sha(value: str) -> str:
    if re.fullmatch(r"[0-9a-f]{40}", value) is None:
        raise DeploymentError("deployment_invalid_sha")
    return value


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (OSError, ValueError):
        raise DeploymentError("deployment_invalid_metadata") from None


def public_file(root: Path, url: str, *, route: bool = False) -> Path:
    if not isinstance(url, str) or not url.startswith("/") or url.startswith("//") or "\\" in url:
        raise DeploymentError("deployment_invalid_public_path")
    parts = url[1:].split("/")
    if any(part in (".", "..") for part in parts) or any(c in url for c in "?#\x00"):
        raise DeploymentError("deployment_invalid_public_path")
    if route and not url.endswith("/"):
        raise DeploymentError("deployment_invalid_public_path")
    relative = PurePosixPath(url.lstrip("/"))
    return root.joinpath(relative, "index.html") if route else root.joinpath(relative)


def validate_artifact(root: Path, sha: str) -> dict[str, str]:
    checked_sha(sha)
    try:
        if root.is_symlink() or not root.is_dir():
            raise DeploymentError("deployment_invalid_candidate")
        hashes = {}
        for directory, directories, files in os.walk(root, followlinks=False):
            for name in directories + files:
                path = Path(directory) / name
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                    raise DeploymentError("deployment_unsafe_artifact")
                if stat.S_ISREG(mode):
                    if mode & 0o6111:
                        raise DeploymentError("deployment_unsafe_artifact")
                    digest = hashlib.sha256()
                    with path.open("rb") as stream:
                        for block in iter(lambda: stream.read(1024 * 1024), b""):
                            digest.update(block)
                    hashes[path.relative_to(root).as_posix()] = digest.hexdigest()
        release = read_json(root / "release.json")
        publication = read_json(root / "_publication.json")
        if release.get("schemaVersion") != 1 or publication.get("schemaVersion") != 1:
            raise DeploymentError("deployment_invalid_metadata")
        if release.get("buildSha") != sha or publication.get("buildSha") != sha:
            raise DeploymentError("deployment_artifact_sha_mismatch")
        routes, assets = publication.get("routes"), publication.get("assets")
        if not isinstance(routes, list) or not routes or not isinstance(assets, list):
            raise DeploymentError("deployment_invalid_metadata")
        for route in routes:
            if not public_file(root, route, route=True).is_file():
                raise DeploymentError("deployment_missing_route")
        for asset in assets:
            if not isinstance(asset, dict):
                raise DeploymentError("deployment_invalid_metadata")
            path = public_file(root, asset.get("url"))
            digest = asset.get("sha256")
            if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                raise DeploymentError("deployment_invalid_metadata")
            if hashes.get(path.relative_to(root).as_posix()) != digest:
                raise DeploymentError("deployment_asset_hash_mismatch")
        return hashes
    except OSError:
        raise DeploymentError("deployment_artifact_unreadable") from None


class ReleaseStore:
    def __init__(self, root: Path):
        if root.is_symlink():
            raise DeploymentError("deployment_invalid_storage")
        self.root = root.absolute()
        self.candidates = self.root / "candidates"
        self.releases = self.root / "releases"
        self.versions = self.releases / "versions"

    def initialize(self) -> None:
        for path in (self.root, self.candidates, self.releases, self.versions):
            if path.is_symlink():
                raise DeploymentError("deployment_invalid_storage")
            path.mkdir(parents=True, exist_ok=True)
        self.candidates.chmod(0o700)
        self.releases.chmod(0o755)
        self.versions.chmod(0o755)
        # Mount the whole releases parent at /usr/share/nginx. The governed
        # serving config keeps its literal /usr/share/nginx/html root unchanged.
        html = self.releases / "html"
        if not os.path.lexists(html):
            html.symlink_to("current")
        if not html.is_symlink() or os.readlink(html) != "current":
            raise DeploymentError("deployment_invalid_storage")

    def current_sha(self) -> str | None:
        pointer = self.releases / "current"
        if not os.path.lexists(pointer):
            return None
        if not pointer.is_symlink():
            raise DeploymentError("deployment_invalid_current")
        target = os.readlink(pointer)
        if not target.startswith("versions/"):
            raise DeploymentError("deployment_invalid_current")
        sha = checked_sha(target.removeprefix("versions/"))
        version = self.versions / sha
        if version.is_symlink() or read_json(version / "release.json").get("buildSha") != sha:
            raise DeploymentError("deployment_invalid_current")
        return sha

    def activate(self, candidate: Path, sha: str) -> dict:
        checked_sha(sha)
        self.initialize()
        if candidate != self.candidates / sha or candidate.is_symlink():
            raise DeploymentError("deployment_invalid_candidate")
        previous = self.current_sha()
        destination = self.versions / sha
        if os.path.lexists(destination):
            raise DeploymentError("deployment_release_exists")
        hashes = validate_artifact(candidate, sha)
        if candidate.stat().st_dev != self.versions.stat().st_dev:
            raise DeploymentError("deployment_cross_filesystem")
        candidate.chmod(0o755)
        for directory, directories, files in os.walk(candidate):
            for name in directories:
                (Path(directory) / name).chmod(0o755)
            for name in files:
                (Path(directory) / name).chmod(0o644)
        os.rename(candidate, destination)
        temporary = self.releases / (".current-" + uuid.uuid4().hex)
        try:
            temporary.symlink_to("versions/" + sha)
            os.replace(temporary, self.releases / "current")
        finally:
            if os.path.lexists(temporary):
                temporary.unlink()
        return {"sha": sha, "previous_sha": previous, "files": hashes}
