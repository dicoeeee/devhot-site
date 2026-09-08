"""A second real deployment process used only by the isolated failure experiment."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from deployment_controller import DeploymentController, DeploymentFailure
from lab_docker import Docker
from lab_source import git
from lab_storage import DockerStore


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text())
    docker = Docker(config["context"], config["run_id"], Path(config["logs"]))
    store = DockerStore.attach(docker, Path(config["candidates"]), config["container"])

    def prepare(sha):
        git(Path(config["source"]), "cat-file", "-e", sha + "^{commit}")
        Path(config["ready"]).write_text("holding")
        deadline = time.monotonic() + 30
        while not Path(config["release"]).exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        raise DeploymentFailure("prepare")

    def unexpected(_sha):
        raise AssertionError("lock probe must stop during preparation")

    controller = DeploymentController(
        store,
        Path(config["state"]),
        Path(config["runtime"]),
        prepare=prepare,
        build=unexpected,
        health=unexpected,
    )
    result = controller.deploy(config["sha"])
    if result["status"] != "failed" or result["phase"] != "prepare":
        raise AssertionError("lock probe did not stop in preparation")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
