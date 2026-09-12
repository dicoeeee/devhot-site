"""Deployment command observations using real Git, files, HTTP and processes."""

import fcntl
import functools
import http.server
import importlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from datetime import datetime, timezone
from unittest.mock import patch

PROJECT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "deploy"))

DeploymentController = importlib.import_module("deployment_controller").DeploymentController
git = importlib.import_module("lab_source").git
ReleaseStore = importlib.import_module("release_store").ReleaseStore
DeploymentError = importlib.import_module("release_store").DeploymentError


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_arguments):
        pass


class DeploymentControllerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        git(self.source, "init", "--quiet", "-b", "main")
        self.first = self.version("first public version")
        self.second = self.version("second public version")
        self.store = ReleaseStore(self.root / "site")
        self.store.initialize()
        self.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(QuietHandler, directory=str(self.store.releases / "html")),
        )
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.controller = DeploymentController(
            self.store,
            self.root / "state",
            self.root / "runtime",
            prepare=self.prepare,
            build=self.build,
            health=self.health,
        )

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def version(self, content):
        (self.source / "index.html").write_text(content)
        git(self.source, "add", "index.html")
        git(self.source, "commit", "--quiet", "-m", "public test version")
        return git(self.source, "rev-parse", "HEAD").strip()

    def prepare(self, sha):
        git(self.source, "cat-file", "-e", sha + "^{commit}")

    def build(self, sha):
        # A small immutable Git-backed artifact at the builder boundary. Full
        # npm builds and Nginx are mandatory in the separate real container lab.
        candidate = self.store.candidates / sha
        candidate.mkdir()
        (candidate / "index.html").write_text(git(self.source, "show", sha + ":index.html"))
        (candidate / "release.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "buildSha": sha,
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                }
            )
        )
        (candidate / "_publication.json").write_text(
            json.dumps({"schemaVersion": 1, "buildSha": sha, "routes": ["/"], "assets": []})
        )
        return candidate

    def read_http(self, path):
        with urllib.request.urlopen(self.url + path, timeout=5) as response:
            return response.read().decode()

    def health(self, sha):
        return json.loads(self.read_http("/release.json"))["buildSha"] == sha and self.read_http(
            "/"
        ) == git(self.source, "show", sha + ":index.html")

    def docker_store_with_real_transport(self):
        # Execute DockerStore's literal storage scripts in a second real local
        # filesystem. Only the transport boundary substitutes for Docker here;
        # the mandatory container lab verifies the native Linux volume too.
        native = self.store
        candidates = self.root / "exported-candidates"
        candidates.mkdir()

        class Transport:
            logs = self.root

            def call(_self, *arguments, **_kwargs):
                script = arguments[4].replace(
                    "Path('/storage')", "Path(" + repr(str(native.root)) + ")"
                )
                return subprocess.run(
                    [sys.executable, "-c", script, *arguments[5:]],
                    env={**os.environ, "PYTHONPATH": str(PROJECT / "deploy")},
                    capture_output=True,
                    text=True,
                )

            def copy_tree(_self, source, target):
                shutil.copytree(
                    source, native.candidates / target.rsplit("/", 1)[1], dirs_exist_ok=True
                )

        transport = Transport()
        self.store = importlib.import_module("lab_storage").DockerStore.attach(
            transport, candidates, "local-transport-fixture"
        )
        self.controller.store = self.store
        return native, transport

    def test_outer_lock_survives_nested_command_exception_and_blocks_other_owners(self):
        with self.controller.locked(create=True):
            with self.assertRaisesRegex(RuntimeError, "inner"), self.controller.locked(create=True):
                raise RuntimeError("inner")
            self.controller.persistence.require_lock(write=True)
            result = self.controller.deploy(self.first)
            self.assertEqual(result["status"], "success")
            competing = subprocess.run(
                [sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1], 'r+'); "
                 "fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)", str(self.controller.lock_file)],
                capture_output=True,
            )
            self.assertNotEqual(competing.returncode, 0)
            errors = []

            def other_thread():
                try:
                    with self.controller.locked(create=True):
                        errors.append("unexpected acquisition")
                except DeploymentError as error:
                    errors.append(str(error))

            thread = threading.Thread(target=other_thread)
            thread.start()
            thread.join(5)
            self.assertEqual(errors, ["deployment_busy"])
            self.controller.persistence.require_lock(write=True)
        with self.controller.locked(create=False):
            with self.assertRaisesRegex(DeploymentError, "deployment_lock_required"):
                self.controller.deploy(self.second)
            self.controller.persistence.require_lock()
            self.assertEqual(self.controller.status()["state"]["current_sha"], self.first)
        self.assertEqual(self.controller.deploy(self.second)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_ref_preparation_failures_share_total_three_attempt_budget(self):
        self.controller.deploy(self.first)
        transient = importlib.import_module("deployment_controller").PreparationUnavailable
        observations = self.root / "attempts"

        def unavailable(sha):
            with observations.open("a") as stream:
                stream.write(sha + "\n")
            raise transient()

        self.controller.prepare = unavailable
        result = self.controller.deploy(self.second, preparation_attempts_used=2)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "prepare")
        self.assertEqual(result["prepare_attempts"], 3)
        self.assertEqual(observations.read_text().splitlines(), [self.second])
        state = self.controller.status()["state"]
        self.assertIsNone(state["failed_sha"])
        self.assertEqual(state["last_observed_sha"], self.second)
        self.assertEqual(self.read_http("/"), "first public version")
        self.assertFalse((self.store.candidates / self.second).exists())
        self.controller.prepare = self.prepare
        self.assertEqual(self.controller.deploy(self.second)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_native_candidate_copy_failure_is_cleaned_and_explicit_retry_succeeds(self):
        native, transport = self.docker_store_with_real_transport()
        self.controller.deploy(self.first)
        original = transport.copy_tree

        def partial_copy(source, target):
            (native.candidates / self.second / "partial").write_text("incomplete transfer")
            raise OSError("controlled transport failure")

        transport.copy_tree = partial_copy
        result = self.controller.deploy(self.second)
        self.assertEqual(result["phase"], "switch")
        self.assertEqual(result["rollback_result"], "passed")
        self.assertFalse((native.candidates / self.second).exists())
        self.assertFalse((self.store.candidates / self.second).exists())
        self.assertEqual(self.read_http("/"), "first public version")
        transport.copy_tree = original
        self.assertEqual(self.controller.deploy(self.second, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_interrupted_native_transfer_requires_recovery_before_retry(self):
        native, transport = self.docker_store_with_real_transport()
        self.controller.deploy(self.first)
        original = transport.copy_tree

        def interrupted_copy(source, target):
            (native.candidates / self.second / "partial").write_text("interrupted transfer")
            raise KeyboardInterrupt()

        transport.copy_tree = interrupted_copy
        with self.assertRaises(KeyboardInterrupt):
            self.controller.deploy(self.second)
        self.assertTrue((native.candidates / self.second / "partial").exists())
        self.assertEqual(self.controller.status()["status"], "recovery_required")
        self.assertEqual(self.read_http("/"), "first public version")
        self.assertEqual(self.controller.recover()["status"], "success")
        self.assertFalse((native.candidates / self.second).exists())
        transport.copy_tree = original
        self.assertEqual(self.controller.deploy(self.second, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_preexisting_native_candidate_is_not_adopted_or_deleted(self):
        native, _transport = self.docker_store_with_real_transport()
        self.controller.deploy(self.first)
        candidate = native.candidates / self.second
        candidate.mkdir()
        (candidate / "unowned").write_text("preserve")
        state = self.controller.state_file.read_bytes()
        with self.assertRaisesRegex(DeploymentError, "^deployment_candidate_exists$"):
            self.controller.deploy(self.second)
        self.assertEqual((candidate / "unowned").read_text(), "preserve")
        self.assertFalse((self.store.candidates / self.second).exists())
        self.assertEqual(self.controller.state_file.read_bytes(), state)
        self.assertEqual(self.read_http("/"), "first public version")

    def test_first_deployment_records_success_only_after_real_http_verification(self):
        result = self.controller.deploy(self.first)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.read_http("/"), "first public version")
        self.assertEqual(self.store.current_sha(), self.first)
        state = self.controller.status()["state"]
        self.assertEqual(state["last_observed_sha"], self.first)
        self.assertEqual(state["last_build_success_sha"], self.first)
        self.assertEqual(state["last_success_sha"], self.first)
        self.assertEqual(state["current_sha"], self.first)
        self.assertIsNone(state["previous_sha"])
        self.assertIsNone(state["failed_sha"])
        state_file = self.root / "state/state.json"
        self.assertEqual(state_file.stat().st_mode & 0o777, 0o600)

    def test_failed_post_switch_health_restores_real_files_http_and_success_state(self):
        self.controller.deploy(self.first)
        self.controller.health = lambda sha: sha != self.second and self.health(sha)
        result = self.controller.deploy(self.second)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["rollback_result"], "passed")
        self.assertEqual(self.store.current_sha(), self.first)
        self.assertEqual(self.read_http("/"), "first public version")
        state = self.controller.status()["state"]
        self.assertEqual(state["last_success_sha"], self.first)
        self.assertEqual(state["current_sha"], self.first)
        self.assertEqual(state["failed_sha"], self.second)
        self.assertEqual(state["failed_phase"], "health")
        self.assertEqual(state["rollback_result"], "passed")

    def test_failures_before_switch_preserve_real_old_http_and_record_the_failed_stage(self):
        DeploymentFailure = importlib.import_module("deployment_controller").DeploymentFailure
        self.controller.deploy(self.first)
        for phase in ("input", "dependencies", "build", "artifact"):
            with self.subTest(phase=phase):
                target = self.version("failed " + phase)

                def failing_build(sha, phase=phase):
                    if phase == "artifact":
                        candidate = self.build(sha)
                        (candidate / "release.json").write_text(
                            json.dumps({"schemaVersion": 1, "buildSha": self.first})
                        )
                        return candidate
                    raise DeploymentFailure(phase) from RuntimeError("PRIVATE_SENTINEL/path")

                self.controller.build = failing_build
                result = self.controller.deploy(target)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(self.store.current_sha(), self.first)
                self.assertEqual(self.read_http("/"), "first public version")
                state = self.controller.status()["state"]
                self.assertEqual(state["last_success_sha"], self.first)
                self.assertEqual(state["failed_sha"], target)
                self.assertEqual(state["failed_phase"], phase)
                self.assertEqual(state["rollback_result"], "not_needed")
                self.assertFalse((self.store.candidates / target).exists())
                self.assertNotIn("PRIVATE_SENTINEL", json.dumps(result))

    def test_real_competing_process_is_busy_without_writes_and_kernel_releases_the_lock(self):
        self.controller.deploy(self.first)
        ready = self.root / "holder-ready"
        script = """
import sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from deployment_controller import DeploymentController
from release_store import ReleaseStore
from lab_source import git
root=Path(sys.argv[2])
def build(sha):
    Path(sys.argv[4]).write_text('holding')
    time.sleep(30)
controller=DeploymentController(ReleaseStore(root/'site'),root/'state',root/'runtime',
    prepare=lambda sha:git(root/'source','cat-file','-e',sha+'^{commit}'),
    build=build,health=lambda sha:False)
controller.deploy(sys.argv[3])
"""
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                script,
                str(PROJECT / "deploy"),
                str(self.root),
                self.second,
                str(ready),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        lock = self.root / "runtime/deployment.lock"
        inode = lock.stat().st_ino
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline and holder.poll() is None:
                time.sleep(0.01)
            self.assertTrue(ready.exists(), "first real process must hold the deployment lock")
            state_bytes = (self.root / "state/state.json").read_bytes()
            start = time.monotonic()
            with self.assertRaisesRegex(DeploymentError, "^deployment_busy$"):
                self.controller.deploy(self.second)
            self.assertLess(time.monotonic() - start, 1)
            self.assertEqual((self.root / "state/state.json").read_bytes(), state_bytes)
            self.assertEqual(self.read_http("/"), "first public version")
            self.assertEqual(self.store.current_sha(), self.first)
        finally:
            holder.kill()
            holder.communicate(timeout=5)
        self.assertEqual(lock.stat().st_ino, inode, "the lock file must not be deleted/replaced")
        descriptor = os.open(lock, os.O_RDWR)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(descriptor)
        self.assertEqual(self.read_http("/"), "first public version")
        unfinished = (self.root / "state/state.json").read_bytes()
        status = self.controller.status()
        self.assertEqual(status["status"], "recovery_required")
        self.assertEqual(status["actual_current_sha"], self.first)
        self.assertEqual((self.root / "state/state.json").read_bytes(), unfinished)
        with self.assertRaisesRegex(DeploymentError, "^deployment_recovery_required$"):
            self.controller.deploy(self.second, retry=True)
        self.assertEqual(self.controller.recover()["status"], "success")
        state = self.controller.status()["state"]
        self.assertEqual(state["failed_sha"], self.second)
        self.assertEqual(state["failed_phase"], "interrupted")
        self.assertEqual(self.read_http("/"), "first public version")
        self.assertEqual(self.controller.deploy(self.second, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_transient_preparation_retries_are_bounded_and_never_mark_an_unobtained_version_failed(
        self,
    ):
        PreparationUnavailable = importlib.import_module(
            "deployment_controller"
        ).PreparationUnavailable
        self.controller.deploy(self.first)
        attempts = self.root / "preparation-attempts"
        attempts.write_text("")

        def eventually_available(sha):
            with attempts.open("a") as stream:
                stream.write("attempt\n")
            if len(attempts.read_text().splitlines()) < 3:
                raise PreparationUnavailable()
            self.prepare(sha)

        self.controller.prepare = eventually_available
        result = self.controller.deploy(self.second)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["prepare_attempts"], 3)
        self.assertEqual(attempts.read_text(), "attempt\nattempt\nattempt\n")
        self.assertEqual(self.read_http("/"), "second public version")
        third = self.version("unavailable public version")
        attempts.write_text("")

        def unavailable(_sha):
            with attempts.open("a") as stream:
                stream.write("attempt\n")
            raise PreparationUnavailable()

        self.controller.prepare = unavailable
        result = self.controller.deploy(third)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["prepare_attempts"], 3)
        self.assertEqual(attempts.read_text(), "attempt\nattempt\nattempt\n")
        self.assertEqual(self.read_http("/"), "second public version")
        state = self.controller.status()["state"]
        self.assertEqual(state["current_sha"], self.second)
        self.assertEqual(state["last_success_sha"], self.second)
        self.assertIsNone(state["failed_sha"])
        self.assertIsNone(state["failed_phase"])
        self.assertEqual(state["last_result"]["phase"], "prepare")

    def test_only_explicit_retry_rebuilds_a_failed_sha_and_success_is_never_overwritten(self):
        self.controller.deploy(self.first)
        original = self.store.versions / self.first / "index.html"
        identity = (original.stat().st_ino, original.stat().st_mtime_ns, original.read_bytes())

        def forbidden(_sha):
            raise AssertionError("unchanged or failed SHA must not start preparation/build")

        self.controller.prepare = forbidden
        result = self.controller.deploy(self.first)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["code"], "deployment_unchanged")
        self.controller.prepare = self.prepare
        self.controller.health = lambda sha: sha != self.second and self.health(sha)
        self.assertEqual(self.controller.deploy(self.second)["status"], "failed")
        self.controller.build = forbidden
        result = self.controller.deploy(self.second)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["code"], "deployment_failed_sha")
        self.assertEqual(self.read_http("/"), "first public version")
        self.controller.build = self.build
        self.controller.health = self.health
        result = self.controller.deploy(self.second, retry=True)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")
        self.assertIsNone(self.controller.status()["state"]["failed_sha"])
        self.assertEqual(
            (original.stat().st_ino, original.stat().st_mtime_ns, original.read_bytes()), identity
        )
        self.controller.build = forbidden
        self.assertEqual(self.controller.deploy(self.second)["code"], "deployment_unchanged")
        third = self.version("never failed version")
        with self.assertRaisesRegex(DeploymentError, "^deployment_retry_not_allowed$"):
            self.controller.deploy(third, retry=True)

    def test_manual_rollback_targets_only_previous_success_and_pauses_the_withdrawn_sha(self):
        self.controller.deploy(self.first)
        self.controller.deploy(self.second)
        second_dir = self.store.versions / self.second

        def identity():
            return {
                path.name: (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes())
                for path in second_dir.iterdir()
            }

        original = identity()

        def forbidden(_sha):
            raise AssertionError("manual rollback must not rebuild")

        self.controller.build = forbidden
        result = self.controller.rollback(self.first)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.read_http("/"), "first public version")
        state = self.controller.status()["state"]
        self.assertEqual(state["current_sha"], self.first)
        self.assertEqual(state["paused_sha"], self.second)
        self.assertEqual(self.controller.deploy(self.second)["code"], "deployment_paused_sha")
        with self.assertRaisesRegex(DeploymentError, "^deployment_rollback_not_allowed$"):
            self.controller.rollback(self.second)
        third = self.version("unknown rollback target")
        with self.assertRaisesRegex(DeploymentError, "^deployment_rollback_not_allowed$"):
            self.controller.rollback(third)
        self.controller.build = self.build
        self.assertEqual(self.controller.deploy(self.second, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")
        self.assertIsNone(self.controller.status()["state"]["paused_sha"])
        self.assertEqual(identity(), original)

    def test_interruption_after_real_switch_is_reported_and_recovery_restores_previous_http(self):
        self.controller.deploy(self.first)
        ready = self.root / "switched-before-health"
        script = """
import sys,time,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from deployment_controller import DeploymentController
from release_store import ReleaseStore
from lab_source import git
root=Path(sys.argv[2]);store=ReleaseStore(root/'site')
def build(sha):
    candidate=store.candidates/sha;candidate.mkdir()
    (candidate/'index.html').write_text(git(root/'source','show',sha+':index.html'))
    (candidate/'release.json').write_text(json.dumps({'schemaVersion':1,'buildSha':sha}))
    (candidate/'_publication.json').write_text(json.dumps({'schemaVersion':1,'buildSha':sha,'routes':['/'],'assets':[]}))
    return candidate
def health(sha):
    Path(sys.argv[4]).write_text('switched')
    time.sleep(30)
    return True
controller=DeploymentController(store,root/'state',root/'runtime',
    prepare=lambda sha:git(root/'source','cat-file','-e',sha+'^{commit}'),build=build,health=health)
controller.deploy(sys.argv[3])
"""
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                script,
                str(PROJECT / "deploy"),
                str(self.root),
                self.second,
                str(ready),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline and process.poll() is None:
                time.sleep(0.01)
            self.assertTrue(ready.exists())
            self.assertEqual(self.read_http("/"), "second public version")
        finally:
            process.kill()
            process.communicate(timeout=5)
        stored = (self.root / "state/state.json").read_bytes()
        status = self.controller.status()
        self.assertEqual(status["status"], "recovery_required")
        self.assertEqual(status["actual_current_sha"], self.second)
        self.assertEqual(status["state"]["last_success_sha"], self.first)
        self.assertEqual((self.root / "state/state.json").read_bytes(), stored)
        result = self.controller.recover()
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rollback_result"], "passed")
        self.assertEqual(self.read_http("/"), "first public version")
        self.assertFalse(self.store.has_version(self.second))
        self.assertEqual(self.controller.status()["state"]["failed_sha"], self.second)
        self.assertEqual(self.controller.deploy(self.second, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_changed_successful_version_is_rejected_before_rollback_or_state_writes(self):
        self.controller.deploy(self.first)
        self.controller.deploy(self.second)
        state_file = self.root / "state/state.json"
        before = state_file.read_bytes()
        first_html = self.store.versions / self.first / "index.html"
        first_html.write_text("changed supposedly immutable bytes")
        with self.assertRaisesRegex(DeploymentError, "^deployment_state_corrupt$"):
            self.controller.rollback(self.first)
        self.assertEqual(state_file.read_bytes(), before)
        self.assertEqual(self.store.current_sha(), self.second)
        self.assertEqual(self.read_http("/"), "second public version")

    def test_status_rejects_malformed_records_without_repairing_or_exposing_them(self):
        self.controller.deploy(self.first)
        state_file = self.root / "state/state.json"
        original = state_file.read_bytes()
        baseline = json.loads(original)
        cases = [
            ("phase", "PRIVATE_SENTINEL"),
            ("prepare_attempts", True),
            ("updated_at", "PRIVATE_SENTINEL/path"),
            ("last_result", {**baseline["last_result"], "code": "PRIVATE_SENTINEL"}),
        ]
        for key, value in cases:
            with self.subTest(field=key):
                corrupted = {**baseline, key: value}
                state_file.write_text(json.dumps(corrupted))
                damaged = state_file.read_bytes()
                try:
                    with self.assertRaisesRegex(DeploymentError, "^deployment_state_corrupt$"):
                        self.controller.status()
                    self.assertEqual(state_file.read_bytes(), damaged)
                    self.assertEqual(self.read_http("/"), "first public version")
                finally:
                    state_file.write_bytes(original)

    def test_fact_timestamps_preserve_build_history_when_checking_or_rolling_back(self):
        self.controller.deploy(self.first)
        first = self.controller.status()["state"]
        for field in ("last_observed_at", "last_build_success_at", "last_success_at"):
            self.assertIsNotNone(datetime.fromisoformat(first[field]).tzinfo)
        self.controller.deploy(self.first)
        checked = self.controller.status()["state"]
        self.assertEqual(checked["last_build_success_at"], first["last_build_success_at"])
        self.assertEqual(checked["last_success_at"], first["last_success_at"])
        self.controller.deploy(self.second)
        second = self.controller.status()["state"]
        self.assertEqual(second["previous_success_at"], first["last_success_at"])
        self.controller.rollback(self.first)
        rolled_back = self.controller.status()["state"]
        self.assertEqual(rolled_back["last_build_success_at"], second["last_build_success_at"])
        self.assertEqual(rolled_back["previous_success_at"], second["last_success_at"])
        self.assertIsNotNone(datetime.fromisoformat(rolled_back["paused_at"]).tzinfo)
        self.assertIsNotNone(datetime.fromisoformat(rolled_back["rollback_recorded_at"]).tzinfo)

    def test_explicit_recovery_can_restore_after_broken_metadata_and_rollback_io_failure(self):
        self.controller.deploy(self.first)
        replace = os.replace

        def fail_rollback(source, destination):
            if (
                pathlib.Path(destination) == self.store.releases / "current"
                and os.readlink(source) == "versions/" + self.first
            ):
                raise OSError("PRIVATE_SENTINEL rollback I/O")
            return replace(source, destination)

        def break_metadata(sha):
            if sha == self.second:
                (self.store.versions / sha / "release.json").unlink()
            return self.health(sha)

        self.controller.health = break_metadata
        with patch("os.replace", side_effect=fail_rollback), self.assertRaises(DeploymentError):
            self.controller.deploy(self.second)
        self.controller.health = self.health
        result = self.controller.recover()
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.read_http("/"), "first public version")
        self.assertFalse(self.store.has_version(self.second))
        self.assertEqual(self.controller.status()["state"]["failed_sha"], self.second)

    def test_forged_new_version_intent_cannot_delete_a_known_success(self):
        self.controller.deploy(self.first)
        self.controller.deploy(self.second)
        state = self.controller.status()["state"]
        state.update(
            phase="recovering",
            pending={
                "action": "deploy",
                "sha": self.first,
                "before_sha": self.second,
                "new_version": True,
                "candidate_owned": False,
                "fingerprints": state["versions"][self.first],
                "failure_phase": "health",
            },
        )
        self.controller.state_file.write_text(json.dumps(state))
        before = self.controller.state_file.read_bytes()
        with self.assertRaisesRegex(DeploymentError, "^deployment_state_corrupt$"):
            self.controller.recover()
        self.assertEqual(self.controller.state_file.read_bytes(), before)
        self.assertTrue(self.store.has_version(self.first))
        self.assertEqual(self.read_http("/"), "second public version")

    def test_failed_switched_versions_do_not_accumulate_when_newer_shas_arrive(self):
        self.controller.deploy(self.first)
        self.controller.health = lambda sha: sha != self.second and self.health(sha)
        self.assertEqual(self.controller.deploy(self.second)["status"], "failed")
        self.assertFalse(self.store.has_version(self.second))
        third = self.version("third public version")
        self.controller.health = self.health
        self.assertEqual(self.controller.deploy(third)["status"], "success")
        self.assertEqual({p.name for p in self.store.versions.iterdir()}, {self.first, third})
        self.assertEqual(self.read_http("/"), "third public version")

    def test_failed_version_cleanup_does_not_misreport_a_successful_http_rollback(self):
        self.controller.deploy(self.first)
        self.controller.health = lambda sha: sha != self.second and self.health(sha)
        remove = self.store.discard_version

        def blocked_cleanup(sha):
            if sha == self.second:
                raise OSError("PRIVATE_SENTINEL cleanup blocked")
            return remove(sha)

        with patch.object(self.store, "discard_version", side_effect=blocked_cleanup):
            result = self.controller.deploy(self.second)
            repeated = self.controller.recover()
            self.assertEqual(repeated["phase"], "cleanup")
            self.assertEqual(repeated["rollback_result"], "not_needed")
            self.assertEqual(self.read_http("/"), "first public version")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "cleanup")
        self.assertEqual(result["rollback_result"], "passed")
        self.assertEqual(self.read_http("/"), "first public version")
        state = self.controller.status()
        self.assertEqual(state["status"], "recovery_required")
        self.assertEqual(state["state"]["failed_phase"], "health")
        self.assertEqual(self.controller.recover()["status"], "success")
        self.assertFalse(self.store.has_version(self.second))
        self.assertEqual(self.read_http("/"), "first public version")

    def test_broken_current_release_metadata_cannot_prevent_automatic_rollback(self):
        self.controller.deploy(self.first)
        for fault in ("missing", "wrong_sha"):
            with self.subTest(fault=fault):
                target = self.version("public metadata fault " + fault)

                def broken_metadata(sha, target=target, fault=fault):
                    if sha == target:
                        self.assertTrue(self.health(sha), "the candidate must first be served")
                        release = self.store.versions / sha / "release.json"
                        if fault == "missing":
                            release.unlink()
                        else:
                            release.write_text(
                                json.dumps({"schemaVersion": 1, "buildSha": self.first})
                            )
                    return self.health(sha)

                self.controller.health = broken_metadata
                result = self.controller.deploy(target)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["phase"], "health")
                self.assertEqual(result["rollback_result"], "passed")
                self.assertEqual(self.read_http("/"), "first public version")
                state = self.controller.status()["state"]
                self.assertEqual(state["last_success_sha"], self.first)
                self.assertEqual(state["failed_sha"], target)

    def test_preparation_exception_from_build_never_retries_a_known_candidate(self):
        self.controller.deploy(self.first)
        unavailable = importlib.import_module("deployment_controller").PreparationUnavailable
        artifacts = self.root / "build-attempts"
        artifacts.mkdir()

        def broken_build(sha):
            (artifacts / str(len(list(artifacts.iterdir())))).write_text(sha)
            raise unavailable()

        self.controller.build = broken_build
        result = self.controller.deploy(self.second)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "build")
        self.assertEqual(result["prepare_attempts"], 1)
        self.assertEqual(len(list(artifacts.iterdir())), 1)
        self.assertEqual(self.controller.status()["state"]["failed_sha"], self.second)
        self.assertEqual(self.read_http("/"), "first public version")

    def test_redirected_serving_root_is_rejected_without_repair(self):
        self.controller.deploy(self.first)
        self.controller.deploy(self.second)
        pointer = self.store.releases / "html"
        pointer.unlink()
        pointer.symlink_to("versions/" + self.first)
        original = self.controller.state_file.read_bytes()
        with self.assertRaisesRegex(DeploymentError, "^deployment_state_corrupt$"):
            self.controller.status()
        self.assertEqual(self.controller.state_file.read_bytes(), original)
        self.assertEqual(os.readlink(pointer), "versions/" + self.first)

    def test_persistent_state_write_failure_after_switch_still_restores_http_and_requires_recovery(
        self,
    ):
        self.controller.deploy(self.first)
        replace = os.replace
        switched = False

        def fail_after_switch(source, destination):
            nonlocal switched
            destination = pathlib.Path(destination)
            if (
                destination == self.store.releases / "current"
                and os.readlink(source) == "versions/" + self.second
            ):
                switched = True
            if switched and destination == self.controller.state_file:
                raise OSError("PRIVATE_SENTINEL persistent state I/O")
            return replace(source, destination)

        with (
            patch("os.replace", side_effect=fail_after_switch),
            self.assertRaisesRegex(DeploymentError, "^deployment_state_write_failed$"),
        ):
            self.controller.deploy(self.second)
        self.assertEqual(self.read_http("/"), "first public version")
        state = self.controller.status()
        self.assertEqual(state["status"], "recovery_required")
        self.assertEqual(state["state"]["last_success_sha"], self.first)
        self.assertIsNotNone(state["state"]["pending"])
        self.assertEqual(self.controller.recover()["status"], "success")
        self.assertEqual(self.read_http("/"), "first public version")

    def test_public_projection_is_allowlisted_and_never_changes_immutable_releases(self):
        self.controller.deploy(self.first)
        before = {
            str(p): p.read_bytes()
            for p in (self.store.versions / self.first).rglob("*")
            if p.is_file()
        }
        self.controller.publish_status()
        public_file = self.store.releases / "maintenance/deployment.json"
        value = json.loads(public_file.read_text())
        self.assertEqual(value["schemaVersion"], 1)
        self.assertEqual(value["current_sha"], self.first)
        self.assertEqual(value["last_success_sha"], self.first)
        self.assertNotIn("versions", value)
        self.assertNotIn("pending", value)
        self.assertEqual(public_file.stat().st_mode & 0o777, 0o644)
        state_file = self.controller.state_file
        original = state_file.read_bytes()
        state = json.loads(original)
        state["last_result"]["code"] = "PRIVATE_SENTINEL /host/secret Bearer fake-secret Traceback"
        state_file.write_text(json.dumps(state))
        damaged = state_file.read_bytes()
        self.controller.publish_status()
        unavailable = json.loads(public_file.read_text())
        self.assertEqual(
            unavailable,
            {"schemaVersion": 1, "status": "unavailable", "code": "deployment_status_unavailable"},
        )
        self.assertEqual(
            state_file.read_bytes(), damaged, "projection must never repair private evidence"
        )
        self.assertEqual(
            before,
            {
                str(p): p.read_bytes()
                for p in (self.store.versions / self.first).rglob("*")
                if p.is_file()
            },
        )
        self.assertEqual(self.read_http("/"), "first public version")

    def test_duplicate_json_and_deep_nesting_are_rejected_without_raw_exception_output(self):
        self.controller.deploy(self.first)
        original = self.controller.state_file.read_bytes()
        for data in (b'{"schemaVersion":999,' + original[1:], b"[" * 1100 + b"0" + b"]" * 1100):
            with self.subTest(data_prefix=data[:40]):
                self.controller.state_file.write_bytes(data)
                with self.assertRaisesRegex(DeploymentError, "^deployment_state_corrupt$"):
                    self.controller.status()
                self.assertEqual(self.controller.state_file.read_bytes(), data)
                self.assertEqual(self.read_http("/"), "first public version")
        self.controller.state_file.write_bytes(original)

    def test_retention_keeps_two_successes_and_cleans_only_after_new_success(self):
        self.controller.deploy(self.first)
        self.controller.deploy(self.second)
        third = self.version("third public version")
        self.controller.health = lambda sha: sha != third and self.health(sha)
        self.assertEqual(self.controller.deploy(third)["status"], "failed")
        self.assertTrue(self.store.has_version(self.first))
        self.assertTrue(self.store.has_version(self.second))
        self.controller.health = self.health
        self.assertEqual(self.controller.deploy(third, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "third public version")
        self.assertFalse(self.store.has_version(self.first))
        state = self.controller.status()["state"]
        self.assertEqual(set(state["versions"]), {self.second, third})
        self.assertEqual(state["retired"], {})
        self.assertEqual(self.controller.rollback(self.second)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_cleanup_failure_retains_audited_ownership_and_does_not_undo_new_success(self):
        self.controller.deploy(self.first)
        self.controller.deploy(self.second)
        third = self.version("third public version")
        remove = self.store.discard_version

        def fail_old(sha):
            if sha == self.first:
                raise OSError("PRIVATE_SENTINEL cleanup")
            return remove(sha)

        with patch.object(self.store, "discard_version", side_effect=fail_old):
            result = self.controller.deploy(third)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "cleanup")
        self.assertEqual(self.read_http("/"), "third public version")
        state = self.controller.status()["state"]
        self.assertEqual(state["last_success_sha"], third)
        self.assertIsNone(state["failed_sha"])
        self.assertEqual(set(state["retired"]), {self.first})
        self.assertTrue(self.store.has_version(self.first))
        self.assertEqual(self.controller.cleanup()["status"], "success")
        self.assertFalse(self.store.has_version(self.first))
        self.assertTrue(self.store.has_version(self.second))
        self.assertEqual(self.controller.status()["state"]["retired"], {})

    def test_atomic_switch_failure_preserves_http_and_records_failed_stage(self):
        self.controller.deploy(self.first)
        replace = os.replace

        def fail_switch(source, destination):
            if (
                pathlib.Path(destination) == self.store.releases / "current"
                and os.readlink(source) == "versions/" + self.second
            ):
                raise OSError("PRIVATE_SENTINEL switch I/O")
            return replace(source, destination)

        with patch("os.replace", side_effect=fail_switch):
            result = self.controller.deploy(self.second)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "switch")
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(result))
        self.assertEqual(self.read_http("/"), "first public version")
        self.assertEqual(self.controller.status()["state"]["failed_sha"], self.second)
        self.assertEqual(self.controller.deploy(self.second, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "second public version")

    def test_success_record_write_failure_restores_old_http_without_claiming_success(self):
        self.controller.deploy(self.first)
        replace = os.replace

        def fail_success_record(source, destination):
            if pathlib.Path(destination) == self.controller.state_file:
                proposed = json.loads(pathlib.Path(source).read_text())
                if proposed["phase"] == "idle" and proposed["last_success_sha"] == self.second:
                    raise OSError("PRIVATE_SENTINEL state I/O")
            return replace(source, destination)

        with patch("os.replace", side_effect=fail_success_record):
            result = self.controller.deploy(self.second)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "state")
        self.assertEqual(result["rollback_result"], "passed")
        self.assertEqual(self.read_http("/"), "first public version")
        state = self.controller.status()["state"]
        self.assertEqual(state["last_success_sha"], self.first)
        self.assertEqual(state["failed_sha"], self.second)
        self.assertNotIn(self.second, state["versions"])

    def test_first_deploy_health_failure_removes_pointer_without_false_rollback_success(self):
        self.controller.health = lambda _sha: False
        result = self.controller.deploy(self.first)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["rollback_result"], "no_previous")
        self.assertIsNone(self.store.current_sha())
        state = self.controller.status()["state"]
        self.assertIsNone(state["last_success_sha"])
        self.assertEqual(state["failed_sha"], self.first)
        self.controller.health = self.health
        self.assertEqual(self.controller.deploy(self.first, retry=True)["status"], "success")
        self.assertEqual(self.read_http("/"), "first public version")

    def test_manual_rollback_health_failure_restores_withdrawn_service_and_keeps_history(self):
        self.controller.deploy(self.first)
        self.controller.deploy(self.second)
        self.controller.health = lambda sha: sha != self.first and self.health(sha)
        result = self.controller.rollback(self.first)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["rollback_result"], "restored_before")
        self.assertEqual(self.read_http("/"), "second public version")
        state = self.controller.status()["state"]
        self.assertEqual(state["last_success_sha"], self.second)
        self.assertEqual(state["previous_sha"], self.first)
        self.assertIsNone(state["paused_sha"])

    def test_failed_rollback_write_is_diagnostic_and_blocks_deploy_until_recovered(self):
        self.controller.deploy(self.first)
        replace = os.replace

        def fail_rollback(source, destination):
            if (
                pathlib.Path(destination) == self.store.releases / "current"
                and os.readlink(source) == "versions/" + self.first
            ):
                raise OSError("PRIVATE_SENTINEL rollback I/O")
            return replace(source, destination)

        self.controller.health = lambda sha: sha != self.second and self.health(sha)
        with patch("os.replace", side_effect=fail_rollback):
            result = self.controller.deploy(self.second)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["rollback_result"], "failed")
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(result))
        status = self.controller.status()
        self.assertEqual(status["status"], "recovery_required")
        self.assertEqual(status["actual_current_sha"], self.second)
        self.assertEqual(status["state"]["last_success_sha"], self.first)
        self.assertEqual(status["state"]["failed_sha"], self.second)
        self.assertEqual(status["state"]["failed_phase"], "health")
        with self.assertRaisesRegex(DeploymentError, "^deployment_recovery_required$"):
            self.controller.deploy(self.second, retry=True)
        self.controller.health = self.health
        self.assertEqual(self.controller.recover()["status"], "success")
        self.assertEqual(self.read_http("/"), "first public version")


if __name__ == "__main__":
    unittest.main()
