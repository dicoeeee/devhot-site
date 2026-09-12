"""Verify the stable LAN entry against the retained immutable release bytes."""

from __future__ import annotations

import hashlib
import json
import time
import urllib.request
from urllib.parse import quote

from release_store import public_file, read_json, validate_artifact


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def healthy(config, store, sha: str) -> bool:
    root = store.versions / sha
    validate_artifact(root, sha)
    manifest = read_json(root / "_publication.json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    started = time.monotonic()

    def get(url):
        remaining = 120 - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError
        with opener.open(
            "http://" + config.lan_ipv4 + quote(url, safe="/"), timeout=min(10, remaining)
        ) as response:
            if response.status != 200:
                raise ValueError
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError
            return data

    try:
        if json.loads(get("/release.json"))["buildSha"] != sha:
            return False
        for route in manifest["routes"]:
            if get(route) != public_file(root, route, route=True).read_bytes():
                return False
        for asset in manifest["assets"]:
            if hashlib.sha256(get(asset["url"])).hexdigest() != asset["sha256"]:
                return False
        return json.loads(get("/release.json"))["buildSha"] == sha
    except (OSError, ValueError, KeyError):
        return False
