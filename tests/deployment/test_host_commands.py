"""Production command composition over the real Git/files/HTTP core fixture."""

import functools
import importlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


class HostCommandTests(unittest.TestCase):
    def setUp(self):
        fixture_type = importlib.import_module(
            "test_deployment_controller"
        ).DeploymentControllerTests
        self.fixture = fixture_type(methodName="runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_ref_lookup_is_locked_and_commands_preserve_observable_state(self):
        fixture = self.fixture
        module = importlib.import_module("host_commands")
        stream = io.StringIO()
        events = module.Events(stream)

        def resolve():
            probe = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import fcntl,sys; f=open(sys.argv[1]); "
                    "fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)",
                    str(fixture.controller.lock_file),
                ],
                capture_output=True,
            )
            self.assertNotEqual(probe.returncode, 0)
            return fixture.second

        class Runtime:
            def check_nginx(self):
                pass  # Docker inspection is independently tested at its boundary.

            def dispose(self):
                pass

            def recover_builders(self):
                pass

        fixture.controller.deploy(fixture.first)
        app = module.HostCommands(fixture.controller, Runtime(), Runtime(), events, resolve)
        result = app.execute("check-main")
        self.assertEqual(result["status"], "success")
        self.assertEqual(fixture.read_http("/"), "second public version")
        self.assertEqual(app.execute("rollback", fixture.first)["status"], "success")
        self.assertEqual(fixture.read_http("/"), "first public version")
        self.assertEqual(app.execute("check-main")["code"], "deployment_paused_sha")
        self.assertEqual(app.execute("retry", fixture.second)["status"], "success")
        self.assertEqual(fixture.read_http("/"), "second public version")
        before = fixture.controller.state_file.read_bytes()
        app.execute("status")
        self.assertEqual(fixture.controller.state_file.read_bytes(), before)
        rows = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertTrue(rows)
        self.assertTrue(
            all(set(row) == {"stage", "sha", "result", "duration_ms", "code"} for row in rows)
        )
        self.assertNotIn(str(fixture.root), stream.getvalue())

    def test_stable_http_health_checks_exact_sha_and_page_bytes_without_proxy(self):
        fixture = self.fixture
        module = importlib.import_module("host_health")
        fixture.controller.deploy(fixture.first)
        config = SimpleNamespace(lan_ipv4=fixture.url.removeprefix("http://"))
        self.assertTrue(module.healthy(config, fixture.store, fixture.first))
        wrong = fixture.root / "wrong-server"
        shutil.copytree(fixture.store.versions / fixture.first, wrong)
        handler = importlib.import_module("test_deployment_controller").QuietHandler
        fixture.server.RequestHandlerClass = functools.partial(handler, directory=str(wrong))
        (wrong / "index.html").write_text("unexpected server content")
        self.assertFalse(module.healthy(config, fixture.store, fixture.first))
        (wrong / "index.html").write_text("first public version")
        (wrong / "release.json").write_text(json.dumps({"buildSha": fixture.second}))
        self.assertFalse(module.healthy(config, fixture.store, fixture.first))
        self.assertEqual(fixture.store.current_sha(), fixture.first)
        self.assertEqual(
            (fixture.store.versions / fixture.first / "index.html").read_text(),
            "first public version",
        )

    def test_builder_network_preparation_does_not_suppress_the_sha_and_next_check_recovers(self):
        fixture = self.fixture
        module = importlib.import_module("host_builder")
        commands = importlib.import_module("host_commands")
        fixture.controller.deploy(fixture.first)
        config = SimpleNamespace(
            state_root=fixture.controller.state_dir,
            release_root=fixture.store.root,
            uid=os.getuid(),
            gid=os.getgid(),
        )

        class Transport:
            environment = importlib.import_module("host_io").command_environment(os.getuid())
            online = False

            def image(self, _image):
                pass

            def check_nginx(self):
                pass

            def call(self, *arguments, **_kwargs):
                failed = arguments[0] == "exec" and not self.online
                return subprocess.CompletedProcess(
                    arguments,
                    int(failed),
                    "",
                    "TypeError: fetch failed; UND_ERR_CONNECT_TIMEOUT" if failed else "",
                )

        transport = Transport()
        events = commands.Events(io.StringIO())
        builder = module.HostBuilder(config, transport, events)
        fixture.controller.prepare = builder.prepare
        app = commands.HostCommands(
            fixture.controller, transport, builder, events, lambda: fixture.second
        )

        def local_fetch(bare, _sha, _environment):
            # Only the external Git transport is substituted; export, private
            # work ownership, controller state, Git blobs and HTTP remain real.
            subprocess.run(
                ["git", "clone", "--quiet", "--bare", str(fixture.source), str(bare)], check=True
            )

        with patch.object(module, "fetch_main", side_effect=local_fetch):
            result = app.execute("check-main")
            self.assertEqual(
                (result["status"], result["phase"], result["prepare_attempts"]),
                ("failed", "prepare", 3),
            )
            self.assertIsNone(fixture.controller.status()["state"]["failed_sha"])
            self.assertEqual(fixture.read_http("/"), "first public version")
            self.assertEqual(list(config.state_root.glob("prepare-*")), [])
            transport.online = True
            self.assertEqual(app.execute("check-main")["status"], "success")
            self.assertEqual(fixture.read_http("/"), "second public version")
            self.assertEqual(list(config.state_root.glob("prepare-*")), [])

    def test_candidate_validation_requires_owner_permissions_and_independent_files(self):
        fixture = self.fixture
        validate = importlib.import_module("host_builder").validate_owned_artifact
        candidate = fixture.build(fixture.first)
        validate(candidate, fixture.first, os.getuid(), os.getgid())
        with self.assertRaisesRegex(Exception, "deployment_artifact_failed"):
            validate(candidate, fixture.first, os.getuid() + 1, os.getgid())
        (candidate / "index.html").chmod(0o666)
        with self.assertRaisesRegex(Exception, "deployment_artifact_failed"):
            validate(candidate, fixture.first, os.getuid(), os.getgid())
        (candidate / "index.html").chmod(0o644)
        os.link(candidate / "index.html", fixture.root / "outside-hardlink")
        with self.assertRaisesRegex(Exception, "deployment_artifact_failed"):
            validate(candidate, fixture.first, os.getuid(), os.getgid())
        self.assertIsNone(fixture.store.current_sha())

    def test_ref_failure_has_three_bounded_attempts_and_does_not_move_site(self):
        fixture = self.fixture
        module = importlib.import_module("host_commands")
        failure = importlib.import_module("deployment_controller").PreparationUnavailable
        fixture.controller.deploy(fixture.first)
        observations = fixture.root / "refs-attempts"

        def resolve():
            with observations.open("a") as stream:
                stream.write("attempt\n")
            raise failure()

        class Runtime:
            def check_nginx(self):
                pass

            def dispose(self):
                pass

        app = module.HostCommands(
            fixture.controller, Runtime(), Runtime(), module.Events(io.StringIO()), resolve
        )
        result = app.execute("check-main")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(observations.read_text().splitlines(), ["attempt"] * 3)
        self.assertEqual(fixture.read_http("/"), "first public version")
        self.assertIsNone(fixture.controller.status()["state"]["failed_sha"])


if __name__ == "__main__":
    unittest.main()
