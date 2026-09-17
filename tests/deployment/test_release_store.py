"""Actual filesystem observations at the deployment command boundary."""

import importlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "deploy"))
store_module = importlib.import_module("release_store")
ReleaseStore = store_module.ReleaseStore
DeploymentError = store_module.DeploymentError


class ReleaseStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name) / "site"
        self.store = ReleaseStore(self.root)
        self.store.initialize()

    def candidate(self, sha):
        path = self.root / "candidates" / sha
        path.mkdir()
        (path / "index.html").write_text("<html>" + sha + "</html>")
        (path / "release.json").write_text(json.dumps({"schemaVersion": 1, "buildSha": sha}))
        (path / "_publication.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "buildSha": sha,
                    "routes": ["/"],
                    "assets": [],
                }
            )
        )
        return path

    def current(self):
        return json.loads((self.root / "releases/current/release.json").read_text())["buildSha"]

    def test_real_upgrade_preserves_old_tree_and_exposes_the_complete_new_version(self):
        first, second = "a" * 40, "b" * 40
        self.store.activate(self.candidate(first), first)
        self.assertEqual(self.current(), first)
        self.candidate(second)
        # Concurrent open-through-symlink assertions run unconditionally in
        # lab_storage_probe on the native Linux volume, the deployment target.
        self.store.activate(self.root / "candidates" / second, second)
        self.assertEqual(self.current(), second)
        self.assertEqual(
            (self.root / "releases/versions" / first / "index.html").read_text(),
            "<html>" + first + "</html>",
        )
        self.assertEqual(
            (self.root / "releases/html").resolve(),
            (self.root / "releases/versions" / second).resolve(),
        )
        self.assertFalse((self.root / "candidates" / second).exists())

    def test_invalid_candidate_does_not_move_current(self):
        first = "a" * 40
        self.store.activate(self.candidate(first), first)
        for index, failure in enumerate(
            (
                "sha",
                "publication_sha",
                "metadata",
                "symlink",
                "executable",
                "route",
                "asset",
                "asset_hash",
            )
        ):
            with self.subTest(failure=failure):
                sha = f"{index + 1:040x}"
                candidate = self.candidate(sha)
                if failure == "sha":
                    (candidate / "release.json").write_text(
                        json.dumps({"schemaVersion": 1, "buildSha": first})
                    )
                elif failure == "publication_sha":
                    metadata = json.loads((candidate / "_publication.json").read_text())
                    metadata["buildSha"] = first
                    (candidate / "_publication.json").write_text(json.dumps(metadata))
                elif failure == "metadata":
                    (candidate / "_publication.json").unlink()
                elif failure == "symlink":
                    (candidate / "leak").symlink_to(self.root)
                elif failure == "executable":
                    (candidate / "index.html").chmod(0o755)
                elif failure == "route":
                    (candidate / "index.html").unlink()
                elif failure == "asset":
                    metadata = json.loads((candidate / "_publication.json").read_text())
                    metadata["assets"] = [{"url": "/missing.png"}]
                    (candidate / "_publication.json").write_text(json.dumps(metadata))
                else:
                    metadata = json.loads((candidate / "_publication.json").read_text())
                    metadata["assets"] = [{"url": "/index.html", "sha256": "0" * 64}]
                    (candidate / "_publication.json").write_text(json.dumps(metadata))
                with self.assertRaises(DeploymentError) as raised:
                    self.store.activate(candidate, sha)
                if failure in ("sha", "publication_sha"):
                    self.assertEqual(str(raised.exception), "deployment_artifact_sha_mismatch")
                if failure == "asset_hash":
                    self.assertEqual(str(raised.exception), "deployment_asset_hash_mismatch")
                self.assertEqual(self.current(), first)
                self.assertTrue(candidate.exists())

    def test_existing_success_cannot_be_overwritten(self):
        sha = "a" * 40
        self.store.activate(self.candidate(sha), sha)
        candidate = self.candidate(sha)
        (candidate / "index.html").write_text("changed")
        with self.assertRaises(DeploymentError):
            self.store.activate(candidate, sha)
        self.assertEqual(
            (self.root / "releases/current/index.html").read_text(), "<html>" + sha + "</html>"
        )

    def test_outside_candidate_and_symlinked_storage_fail_closed(self):
        sha = "a" * 40
        candidate = self.candidate(sha)
        outside = self.root / "outside"
        candidate.rename(outside)
        with self.assertRaises(DeploymentError):
            self.store.activate(outside, sha)
        self.assertFalse((self.root / "releases/current").exists())
        (self.root / "candidates" / sha).symlink_to(outside)
        with self.assertRaises(DeploymentError):
            self.store.activate(self.root / "candidates" / sha, sha)

    def test_missing_runtime_public_command_fails_without_skip(self):
        result = subprocess.run(
            [sys.executable, str(PROJECT / "deploy/lab.py"), "--preflight"],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin", "DOCKER_HOST": "unix:///nonexistent-devhot-lab.sock"},
        )
        self.assertEqual(result.returncode, 1)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["code"], "deployment_runtime_unavailable")
        self.assertNotIn("skip", result.stdout.lower())

    def test_remote_daemon_is_rejected_before_access(self):
        result = subprocess.run(
            [sys.executable, str(PROJECT / "deploy/lab.py"), "--preflight"],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            env={
                "PATH": "/usr/bin:/bin",
                "DOCKER_HOST": "tcp://PRIVATE_MARKER@example.invalid:2376",
            },
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["code"], "deployment_requires_local_unix_socket")
        self.assertNotIn("PRIVATE_MARKER", result.stdout + result.stderr)

    def docker_info_command(self, directory, stdout, *, returncode=0, full=False):
        tools = directory / "tools"
        tools.mkdir(parents=True)
        state = directory / "daemon-state"
        state.write_text("existing resources unchanged")
        observed = directory / "info-observed"
        docker = tools / "docker"
        docker.write_text(
            f"#!{sys.executable}\n"
            "import pathlib, sys\n"
            "if sys.argv[1:] != ['info', '--format', '{{json .}}']:\n"
            f"    pathlib.Path({str(state)!r}).write_text('unexpected daemon action')\n"
            "    sys.exit(99)\n"
            f"pathlib.Path({str(observed)!r}).write_text('info')\n"
            f"sys.stdout.write({stdout!r})\n"
            "sys.stderr.write('PRIVATE_DOCKER_MARKER unix:///private-daemon.sock')\n"
            f"sys.exit({returncode})\n"
        )
        docker.chmod(0o755)
        output = directory / "lab-result"
        result = subprocess.run(
            [
                sys.executable,
                str(PROJECT / "deploy/lab.py"),
                *(["--output", str(output)] if full else ["--preflight"]),
            ],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            timeout=15,
            env={
                "PATH": str(tools) + os.pathsep + "/usr/bin:/bin",
                "DOCKER_HOST": "unix:///private-daemon.sock",
            },
        )
        self.assertEqual(observed.read_text(), "info")
        self.assertEqual(state.read_text(), "existing resources unchanged")
        receipts = [json.loads(line) for line in result.stdout.splitlines()]
        evidence = result.stdout + result.stderr
        if full:
            evidence += "".join(path.read_text() for path in output.rglob("*") if path.is_file())
            report = json.loads((output / "report.json").read_text())
            self.assertEqual(len(receipts), 2)
            self.assertEqual(
                receipts[0],
                {
                    "run_id": report["run_id"],
                    "phase": "cleanup",
                    "status": "passed",
                    "owned_resources_removed": True,
                },
            )
            self.assertEqual(receipts[-1], {"status": report["status"], "code": report["code"]})
            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["failure_phase"], "preflight")
            self.assertEqual(
                [event["phase"] for event in report["events"]], ["preflight", "cleanup"]
            )
            self.assertFalse((output / "work").exists())
        else:
            self.assertEqual(len(receipts), 1)
            self.assertFalse(output.exists())
        self.assertNotIn("PRIVATE_DOCKER_MARKER", evidence)
        self.assertNotIn("private-daemon.sock", evidence)
        self.assertEqual(result.stderr, "")
        return result

    def test_docker_info_failures_are_unavailable_without_deployment_actions(self):
        supported = {"OSType": "linux", "Architecture": "arm64", "ServerVersion": "28.0.4"}
        responses = [
            (json.dumps({**supported, "ServerErrors": ["PRIVATE_DOCKER_MARKER"]}), 0),
            (json.dumps({"ServerErrors": ["PRIVATE_DOCKER_MARKER"], "OSType": ""}), 0),
            ("", 0),
            ("{PRIVATE_DOCKER_MARKER", 0),
            ("{}", 0),
            ("[]", 0),
            ("null", 0),
            ('"PRIVATE_DOCKER_MARKER"', 0),
            ("42", 0),
            ("false", 0),
            (json.dumps(supported), 1),
        ]
        for field in supported:
            responses.append(
                (json.dumps({key: value for key, value in supported.items() if key != field}), 0)
            )
            for value in (None, "", " \t", 28):
                responses.append((json.dumps({**supported, field: value}), 0))
        for index, (stdout, returncode) in enumerate(responses):
            # Exercise representative errors through the full deployment command
            # as well; field variants share the same preflight failure boundary.
            for full in (False, True) if index in (0, 3, 4, 10) else (False,):
                with self.subTest(response=index, full=full):
                    result = self.docker_info_command(
                        self.root / f"response-{index}-{full}",
                        stdout,
                        returncode=returncode,
                        full=full,
                    )
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(
                        json.loads(result.stdout.splitlines()[-1]),
                        {"status": "failed", "code": "deployment_runtime_unavailable"},
                    )

    def test_complete_docker_info_distinguishes_supported_and_unsupported_platforms(self):
        for architecture in ("aarch64", "arm64", "x86_64", "amd64"):
            with self.subTest(architecture=architecture):
                info = {
                    "OSType": "linux",
                    "Architecture": architecture,
                    "ServerVersion": "28.0.4",
                    "ServerErrors": [],
                }
                result = self.docker_info_command(self.root / architecture, json.dumps(info))
                self.assertEqual(result.returncode, 0)
                self.assertEqual(
                    json.loads(result.stdout),
                    {
                        "status": "passed",
                        "phase": "preflight",
                        "os": "linux",
                        "architecture": architecture,
                        "server_version": "28.0.4",
                    },
                )
        for os_type, architecture in (("windows", "amd64"), ("linux", "riscv64")):
            for full in (False, True):
                with self.subTest(os_type=os_type, architecture=architecture, full=full):
                    result = self.docker_info_command(
                        self.root / f"unsupported-{os_type}-{full}",
                        json.dumps(
                            {
                                "OSType": os_type,
                                "Architecture": architecture,
                                "ServerVersion": "28.0.4",
                            }
                        ),
                        full=full,
                    )
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(
                        json.loads(result.stdout.splitlines()[-1]),
                        {
                            "status": "failed",
                            "code": "deployment_unsupported_platform",
                        },
                    )

    def test_full_command_never_cleans_up_a_rejected_remote_daemon(self):
        tools = self.root / "tools"
        tools.mkdir()
        accessed = self.root / "daemon-accessed"
        docker = tools / "docker"
        docker.write_text('#!/bin/sh\nprintf accessed > "$PROBE_MARKER"\nexit 1\n')
        docker.chmod(0o755)
        output = self.root / "lab-result"
        result = subprocess.run(
            [sys.executable, str(PROJECT / "deploy/lab.py"), "--output", str(output)],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            env={
                "PATH": str(tools) + os.pathsep + "/usr/bin:/bin",
                "DOCKER_HOST": "tcp://example.invalid:2376",
                "PROBE_MARKER": str(accessed),
            },
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(accessed.exists(), "rejected endpoint must never be accessed")
        self.assertEqual(
            json.loads(result.stdout.splitlines()[-1])["code"],
            "deployment_requires_local_unix_socket",
        )
        report = json.loads((output / "report.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertFalse((output / "work").exists())

    def test_output_cannot_recursively_enter_the_source_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="lab-output-probe-", dir=PROJECT) as directory:
            output = pathlib.Path(directory) / "result"
            result = subprocess.run(
                [sys.executable, str(PROJECT / "deploy/lab.py"), "--output", str(output)],
                cwd=PROJECT,
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin"},
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["code"], "deployment_output_inside_source")
            self.assertFalse(output.exists())

    def test_source_snapshot_excludes_untracked_files_but_includes_intent_to_add(self):
        sys.path.insert(0, str(PROJECT / "deploy"))
        from lab_source import SourceFixture, git

        project = self.root / "public-project"
        project.mkdir()
        (project / "site-input/data").mkdir(parents=True)
        (project / "site-input/data/home.json").write_text('{"schemaVersion":2,"domains":[]}')
        git(project, "init", "--quiet", "-b", "main")
        git(project, "add", ".")
        git(project, "commit", "--quiet", "-m", "public fixture")
        (project / "reviewed.py").write_text("print('public reviewed change')\n")
        git(project, "add", "--intent-to-add", "reviewed.py")
        (project / "private-untracked.txt").write_text("PRIVATE_TEST_MARKER")
        fixture = SourceFixture(project, self.root / "snapshot")
        self.assertFalse((fixture.root / "private-untracked.txt").exists())
        self.assertEqual(
            (fixture.root / "reviewed.py").read_text(), "print('public reviewed change')\n"
        )
        data = project / "site-input/data"
        outside = self.root / "outside-data"
        data.rename(outside)
        data.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(DeploymentError):
            SourceFixture(project, self.root / "unsafe-snapshot")
        self.assertFalse((self.root / "unsafe-snapshot/site-input/data/home.json").exists())

    def test_source_snapshot_preserves_indexed_names_without_copying_untracked_collisions(self):
        sys.path.insert(0, str(PROJECT / "deploy"))
        from lab_source import SourceFixture, git

        for index, name in enumerate(
            (" public.txt", "\tpublic.txt", "\rpublic.txt", "line\rname.txt")
        ):
            with self.subTest(name=name):
                project = self.root / f"public-project-{index}"
                (project / "site-input/data").mkdir(parents=True)
                (project / "site-input/data/home.json").write_text(
                    '{"schemaVersion":2,"domains":[]}'
                )
                (project / name).write_text("INDEXED PUBLIC CONTENT")
                git(project, "init", "--quiet", "-b", "main")
                git(project, "add", ".")
                shadow = "line\nname.txt" if name == "line\rname.txt" else "public.txt"
                (project / shadow).write_text("UNTRACKED PRIVATE SENTINEL")
                fixture = SourceFixture(project, self.root / f"snapshot-{index}")
                self.assertFalse((fixture.root / shadow).exists())
                self.assertEqual((fixture.root / name).read_text(), "INDEXED PUBLIC CONTENT")

    def test_source_export_preserves_indexed_names_without_copying_untracked_collisions(self):
        sys.path.insert(0, str(PROJECT / "deploy"))
        from lab_source import SourceFixture, git

        project = self.root / "public-project"
        (project / "site-input/data").mkdir(parents=True)
        (project / "site-input/data/home.json").write_text('{"schemaVersion":2,"domains":[]}')
        git(project, "init", "--quiet", "-b", "main")
        git(project, "add", ".")
        fixture = SourceFixture(project, self.root / "snapshot")
        for name in (" public.txt", "line\rname.txt"):
            (fixture.root / name).write_text("INDEXED PUBLIC CONTENT")
            git(fixture.root, "add", "--", name)
        for name in ("public.txt", "line\nname.txt"):
            (fixture.root / name).write_text("UNTRACKED PRIVATE SENTINEL")
        exported = self.root / "exported"
        fixture.export(exported)
        for name in ("public.txt", "line\nname.txt"):
            self.assertFalse((exported / name).exists())
        for name in (" public.txt", "line\rname.txt"):
            self.assertEqual((exported / name).read_text(), "INDEXED PUBLIC CONTENT")
        self.assertFalse((exported / ".git").exists())

    def test_timed_out_docker_process_has_a_distinct_diagnostic(self):
        sys.path.insert(0, str(PROJECT / "deploy"))
        from lab_docker import Docker

        tools = self.root / "timeout-tools"
        tools.mkdir()
        executable = tools / "docker"
        executable.write_text("#!" + sys.executable + "\nimport time\ntime.sleep(5)\n")
        executable.chmod(0o755)
        driver = Docker(None, "timeout-probe", self.root)
        environment = patch.dict(os.environ, {"PATH": str(tools) + os.pathsep + "/usr/bin:/bin"})
        with environment, self.assertRaisesRegex(DeploymentError, "^deployment_docker_timeout$"):
            driver.call("info", timeout=0.05)

    def test_explicit_debian_mirror_preserves_signed_sources_and_rejects_other_inputs(self):
        source = self.root / "debian.sources"
        original = (
            "Types: deb\nURIs: http://deb.debian.org/debian\n"
            "Suites: bookworm bookworm-updates\nComponents: main\n"
            "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\n"
            "Types: deb\nURIs: http://deb.debian.org/debian-security\n"
            "Suites: bookworm-security\nComponents: main\n"
            "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg\n"
        )
        source.write_text(original)
        command = [sys.executable, str(PROJECT / "deploy/lab_apt.py"), "--sources", str(source)]
        clean_environment = {"PATH": "/usr/bin:/bin"}
        result = subprocess.run(command, env=clean_environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(source.read_text(), original)
        environment = {**clean_environment, "DEVHOT_LAB_DEBIAN_MIRROR": "ustc"}
        result = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            source.read_text(),
            original.replace("http://deb.debian.org", "https://mirrors.ustc.edu.cn"),
        )
        for selected in ("https://unapproved.invalid", "ustc; touch injected"):
            source.write_text(original)
            result = subprocess.run(
                command,
                env={**clean_environment, "DEVHOT_LAB_DEBIAN_MIRROR": selected},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("deployment_invalid_debian_mirror", result.stdout)
            self.assertEqual(source.read_text(), original)
        source.write_text(original.replace("deb.debian.org/debian-security", "other.invalid/repo"))
        before = source.read_bytes()
        result = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("deployment_unexpected_apt_sources", result.stdout)
        self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
