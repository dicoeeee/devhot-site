"""Real Nginx deployment failures; substitutes only introduce deterministic faults."""

from __future__ import annotations

import json
import subprocess
import sys
import time

from deployment_controller import DeploymentController, DeploymentFailure, PreparationUnavailable
from lab import Lab
from lab_source import git
from release_store import DeploymentError, checked_sha

NEGATIVE_BUILD = """set -eu
rm -rf /workspace
mkdir /workspace
cp -a /source/. /workspace/
cd /workspace
test ! -e /var/run/docker.sock
test ! -e /state
test ! -e /current
npm ci
npm run validate:input
npm run build:site
exit 97
"""


def require(condition, code="deployment_failure_scenario_rejected") -> None:
    if not condition:
        raise DeploymentError(code)


class RecoveryLab(Lab):
    def exercise(self, fixture, store, node_image, build_network, service_network) -> None:
        markers = {}
        first = fixture.version("LAB-V1-" + self.run_id)
        markers[first] = "LAB-V1-" + self.run_id
        second = fixture.version("LAB-V2-" + self.run_id)
        markers[second] = "LAB-V2-" + self.run_id
        build_number = 0
        server = None
        client_image = None
        before = None

        def prepare(sha):
            git(fixture.root, "cat-file", "-e", sha + "^{commit}")
            git(fixture.root, "checkout", "--quiet", "--detach", sha)

        def build(sha):
            nonlocal build_number, server, client_image, before
            build_number += 1
            builder = self.builder(
                fixture, store, sha, "full-" + str(build_number), node_image, build_network
            )
            if server is None:
                client_image = self.docker.commit_client(builder)
                server = self.nginx(store, service_network, fixture.root)
                before = self.docker.inspect(server)
                self.start_client(client_image, service_network, fixture.root, server)
            return store.candidates / sha

        def health(sha):
            result = self.client.command({"action": "health", "sha": sha, "marker": markers[sha]})
            return result["healthy"] is True

        controller = DeploymentController(
            store,
            self.work / "state",
            self.work / "runtime",
            prepare=prepare,
            build=build,
            health=health,
        )

        def verify_current(sha):
            require(store.current_sha() == sha and health(sha))
            require(controller.status()["state"]["current_sha"] == sha)

        def record_result(phase, result, serving):
            verify_current(serving)
            projection = controller.publish_status()
            public = self.client.command({"action": "maintenance", "expected": projection})
            self.record(phase, operation=result, http_sha=serving, maintenance=public)

        result = controller.deploy(first)
        require(result["status"] == "success")
        record_result("controlled_v1", result, first)
        self.record(
            "http_v1",
            **{
                key: value
                for key, value in self.client.verify(first, markers[first]).items()
                if key != "status"
            },
        )

        # Each invalid source is a separate real Git commit. Container commands
        # genuinely reject invalid input, dependency installation, or compilation.
        for phase in ("input", "dependencies", "build"):
            prepare(second)
            if phase == "input":
                path = fixture.root / "site-input/data/home.json"
                path.write_text('{"schemaVersion":999}\n')
            elif phase == "dependencies":
                path = fixture.root / "package.json"
                package = json.loads(path.read_text())
                package["dependencies"]["astro"] = "0.0.0-devhot-impossible"
                path.write_text(json.dumps(package))
            else:
                path = fixture.root / "astro.config.mjs"
                require(path.is_file())
                path.write_text("throw new Error('LAB deterministic build failure');\n")
            git(fixture.root, "add", str(path.relative_to(fixture.root)))
            git(fixture.root, "commit", "--quiet", "-m", "isolated " + phase + " failure")
            target = checked_sha(git(fixture.root, "rev-parse", "HEAD").strip())

            def rejected_build(sha, phase=phase):
                try:
                    self.builder(
                        fixture,
                        store,
                        sha,
                        "reject-" + phase,
                        client_image,
                        build_network,
                        command=NEGATIVE_BUILD,
                    )
                except DeploymentError as error:
                    require(str(error) == "deployment_build_failed")
                    log = (self.logs / ("build-reject-" + phase + ".log")).read_text()
                    expected = {
                        "input": "validate:input",
                        "dependencies": "npm error",
                        "build": "LAB deterministic build failure",
                    }[phase]
                    require(expected in log)
                    if phase == "input":
                        require("build:site" not in log)
                    if phase == "dependencies":
                        require("validate:input" not in log)
                    raise DeploymentFailure(phase) from None
                raise AssertionError("negative builder unexpectedly succeeded")

            controller.build = rejected_build
            result = controller.deploy(target)
            require(
                result["status"] == "failed"
                and result["phase"] == phase
                and result["prepare_attempts"] == 1
            )
            require(controller.status()["state"]["failed_sha"] == target)
            record_result("rejected_" + phase, result, first)

        # Alter an actually built Astro artifact at the output boundary. This is
        # explicitly a fault fixture, never a successful build or synthetic HTTP.
        controller.build = build
        prepare(second)
        (fixture.root / "lab-artifact-fault.txt").write_text("public fault fixture\n")
        git(fixture.root, "add", "lab-artifact-fault.txt")
        git(fixture.root, "commit", "--quiet", "-m", "isolated artifact failure")
        artifact_sha = checked_sha(git(fixture.root, "rev-parse", "HEAD").strip())

        def broken_artifact(sha):
            candidate = store.candidates / sha
            candidate.mkdir()
            self.docker.call(
                "cp",
                store.container + ":/storage/releases/versions/" + first + "/.",
                str(candidate),
            )
            return candidate

        controller.build = broken_artifact
        result = controller.deploy(artifact_sha)
        require(
            result["status"] == "failed"
            and result["phase"] == "artifact"
            and result["prepare_attempts"] == 1
        )
        record_result("rejected_artifact", result, first)
        controller.build = build

        # Acquisition failure must not mark an unobtained SHA as a failed build.
        attempts = []

        def unavailable(_sha):
            attempts.append(time.monotonic())
            raise PreparationUnavailable()

        controller.prepare = unavailable
        failed_before = controller.status()["state"]["failed_sha"]
        result = controller.deploy(second)
        require(
            result["status"] == "failed" and result["phase"] == "prepare" and len(attempts) == 3
        )
        require(controller.status()["state"]["failed_sha"] == failed_before)
        record_result("preparation_exhausted", result, first)
        controller.prepare = prepare

        self.verify_lock_competition(controller, fixture, store, second, first, health)

        # Remove only the experiment's new release metadata after observing v2.
        # Real HTTP now returns 404; failed metadata must not block rollback.
        observed_failed_health = []

        def reject_second(sha):
            actual = health(sha)
            if sha == second:
                require(actual)
                store.execute(
                    "(store.versions / sys.argv[1] / 'release.json').unlink()",
                    sha,
                )
                unhealthy = health(sha)
                observed_failed_health.append(unhealthy)
                return unhealthy
            return actual

        controller.health = reject_second
        result = controller.deploy(second)
        require(observed_failed_health == [False])
        require(result["status"] == "failed" and result["rollback_result"] == "passed")
        state = controller.status()["state"]
        require(
            state["last_success_sha"] == first
            and state["failed_sha"] == second
            and state["failed_phase"] == "health"
        )
        record_result("automatic_rollback", result, first)
        require(controller.deploy(second)["code"] == "deployment_failed_sha")
        verify_current(first)

        controller.health = health
        attempts.clear()

        def eventually_ready(sha):
            attempts.append(time.monotonic())
            if len(attempts) < 3:
                raise PreparationUnavailable()
            prepare(sha)

        controller.prepare = eventually_ready
        result = controller.deploy(second, retry=True)
        require(result["status"] == "success" and result["prepare_attempts"] == 3)
        controller.prepare = prepare
        record_result("explicit_failed_retry", result, second)
        self.record(
            "http_v2",
            **{
                key: value
                for key, value in self.client.verify(second, markers[second]).items()
                if key != "status"
            },
        )

        immutable = store.version_fingerprints(second)
        result = controller.rollback(first)
        require(
            result["status"] == "success" and controller.status()["state"]["paused_sha"] == second
        )
        record_result("manual_rollback", result, first)
        require(controller.deploy(second)["code"] == "deployment_paused_sha")
        try:
            controller.rollback(second)
        except DeploymentError as error:
            require(str(error) == "deployment_rollback_not_allowed")
        else:
            raise AssertionError("paused SHA bypassed explicit retry")
        verify_current(first)
        result = controller.deploy(second, retry=True)
        require(result["status"] == "success" and store.version_fingerprints(second) == immutable)
        record_result("explicit_paused_retry", result, second)
        require(controller.deploy(second)["code"] == "deployment_unchanged")
        require(store.version_fingerprints(second) == immutable)
        verify_current(second)

        state_file = controller.state_file
        original = state_file.read_bytes()
        damaged = json.loads(original)
        damaged["last_result"]["code"] = (
            "PRIVATE_SENTINEL /host/private Bearer fake-secret Traceback"
        )
        state_file.write_text(json.dumps(damaged))
        try:
            projection = controller.publish_status()
            require(
                projection
                == {
                    "schemaVersion": 1,
                    "status": "unavailable",
                    "code": "deployment_status_unavailable",
                }
            )
            self.client.command({"action": "maintenance", "expected": projection})
            require(health(second))
            self.record(
                "public_status_redaction",
                unavailable_projection=projection,
                old_http_preserved=True,
            )
        finally:
            state_file.write_bytes(original)
        controller.publish_status()
        require(build_number == 4)
        self.record(
            "failure_matrix_complete",
            full_clean_builds=build_number,
            first_sha=first,
            second_sha=second,
            current_sha=store.current_sha(),
            immutable_success_preserved=True,
        )
        self.verify_isolation(server, before, service_network, build_network, node_image)

    def verify_lock_competition(self, controller, fixture, store, target, serving, health):
        ready, release = self.work / "lock-ready", self.work / "lock-release"
        config = self.work / "lock-probe.json"
        config.write_text(
            json.dumps(
                {
                    "context": self.context,
                    "run_id": self.run_id,
                    "logs": str(self.logs),
                    "candidates": str(store.candidates),
                    "container": store.container,
                    "state": str(controller.state_dir),
                    "runtime": str(controller.runtime_dir),
                    "source": str(fixture.root),
                    "ready": str(ready),
                    "release": str(release),
                    "sha": target,
                }
            )
        )
        inode = controller.lock_file.stat().st_ino
        process = subprocess.Popen(
            [sys.executable, str(fixture.root / "deploy/lab_lock_probe.py"), str(config)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 20
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            require(ready.exists(), "deployment_lock_probe_unavailable")
            before = controller.state_file.read_bytes()
            started = time.monotonic()
            try:
                controller.deploy(target)
            except DeploymentError as error:
                require(str(error) == "deployment_busy")
            else:
                raise AssertionError("competing deployment acquired an owned lock")
            elapsed = time.monotonic() - started
            require(elapsed < 1 and controller.state_file.read_bytes() == before)
            require(store.current_sha() == serving and health(serving))
        finally:
            release.write_text("release own fault probe")
            try:
                output, errors = process.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise DeploymentError("deployment_lock_probe_timeout") from None
        require(process.returncode == 0, "deployment_lock_probe_failed")
        require(controller.lock_file.stat().st_ino == inode)
        require(controller.status()["state"]["current_sha"] == serving)
        self.record(
            "lock_competition",
            busy_seconds=elapsed,
            lock_inode_preserved=True,
            competing_operation=json.loads(output),
            serving_sha=serving,
        )
