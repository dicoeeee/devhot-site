"""Check observable host evidence; no fake observations are accepted by the CLI."""

import copy
import importlib
import json
import pathlib
import sys
import unittest
from subprocess import CompletedProcess

PROJECT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "deploy"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
fixtures = importlib.import_module("host_fixtures")
healthy_host, instance = fixtures.healthy_host, fixtures.instance


class HostChecksTests(unittest.TestCase):
    def test_every_subordinate_range_must_be_safe_not_just_one(self):
        config = importlib.import_module("host_config").parse_config(instance())
        assess = importlib.import_module("host_checks").assess_host
        for key in ("subuid", "subgid"):
            identity = config.uid if key == "subuid" else config.gid
            for extra in (
                (0, 1),
                (-1, 1),
                (400000, 0),
                (identity, 1),
                (231073, 65536),
                (2**32 - 2, 3),
            ):
                with self.subTest(key=key, extra=extra):
                    evidence = healthy_host()
                    evidence[key] = [(231072, 65536), extra]
                    report = assess(config, evidence)
                    self.assertEqual(report["status"], "failed")

    def test_missing_or_unsafe_host_conditions_fail_closed_without_echoing_details(self):
        config = importlib.import_module("host_config").parse_config(instance())
        checks = importlib.import_module("host_checks")
        cases = [
            (("platform",), "darwin"),
            (("uid",), 0),
            (("account", "shell"), "/bin/bash"),
            (("groups",), ["sudo"]),
            (("groups",), ["devhot-site", "extra-readers"]),
            (("group_ids",), [0, 1001]),
            (("sudo_policy",), "unverified"),
            (("no_new_privileges",), False),
            (("rootful_socket_access",), True),
            (("daemon_unix_only",), False),
            (("daemon_unix_only",), None),
            (("subuid",), [(231072, 65535)]),
            (("subgid",), []),
            (("mapping_helpers",), False),
            (("user_namespace",), False),
            (("cgroup_controllers",), ["memory"]),
            (("docker", "SecurityOptions"), ["name=not-rootless"]),
            (("docker", "CgroupDriver"), "none"),
            (("docker", "CgroupVersion"), "1"),
            (("docker", "MemoryLimit"), False),
            (("docker", "Plugins", "Log"), ["json-file"]),
            (("socket", "mode"), 0o666),
            (("socket", "uid"), 0),
            (("rootlesskit", "uid"), 1001),
            (("rootlesskit", "mode"), 0o777),
            (("rootlesskit", "canonical"), False),
            (("rootlesskit", "trusted_parents"), False),
            (("rootlesskit", "sha256"), "b" * 64),
            (("rootlesskit", "inode"), 12346),
            (("rootlesskit", "capabilities"), "cap_net_bind_service,cap_sys_admin=ep"),
            (("rootlesskit", "launch_chain_valid"), False),
            (("rootlesskit", "proof"), "unverified"),
            (("rootlesskit", "started_after_files"), False),
            (("rootlesskit", "pid_stable"), False),
            (("rootlesskit", "process_uid"), 0),
            (("rootlesskit", "process_cap_effective"), 0),
            (("rootlesskit", "process_cap_permitted"), (1 << 10) | (1 << 19)),
            (("directories", "state_root", "mode"), 0o755),
            (("directories", "state_root", "secure_ancestors"), False),
            (("directories", "releases", "device"), 5),
            (("installed_tools_trusted",), False),
            (("empty_docker_config",), False),
            (("site_units",), False),
            (("compose_plugin",), False),
            (("lan_addresses",), ["127.0.0.1"]),
            (("daemon_service", "ActiveState"), "failed"),
            (("timer", "UnitFileState"), "enabled"),
        ]
        for path, value in cases:
            with self.subTest(path=path):
                evidence = healthy_host()
                target = evidence
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                report = checks.assess_host(config, evidence)
                self.assertEqual(report["status"], "failed")
                self.assertTrue(any(c["status"] == "failed" for c in report["checks"]))
                self.assertNotIn("SECRET", json.dumps(report))
        report = checks.assess_host(config, {})
        self.assertEqual(report["status"], "failed")
        evidence = healthy_host()
        evidence["timer"].update(ActiveState="active", UnitFileState="enabled")
        # Later administrator-authorized timer activation is observable; runtime
        # deployment does not silently disable an already approved schedule.
        self.assertEqual(
            checks.assess_host(config, evidence, require_disabled_timer=False)["status"], "passed"
        )

    def test_private_identity_is_explicit_allowlist_without_config_or_secret_echo(self):
        project = importlib.import_module("host_checks").operator_identity
        evidence = healthy_host()
        evidence["rootlesskit"].update(secret="PRIVATE_SENTINEL", lan_ipv4="PRIVATE_SENTINEL")
        result = project(evidence)
        self.assertEqual(result["path"], "/usr/bin/rootlesskit")
        self.assertEqual(result["proof"], "trusted_launch_chain")
        self.assertEqual(result["inode"], 12345)
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(result))
        self.assertNotIn("process_inode", result)
        self.assertEqual(project({}), {"status": "unavailable"})

    def test_sudo_requires_account_bound_policy_denial_not_authentication_failure(self):
        denied = importlib.import_module("host_probe").sudo_denied
        message = "Sorry, user devhot-site may not run sudo on test-host.\n"
        self.assertTrue(denied(CompletedProcess([], 1, "", message)))
        for result in (
            CompletedProcess([], 0, "", message),
            CompletedProcess([], 1, "", "sudo: a password is required\n"),
            CompletedProcess([], 1, "", "sudo: no new privileges flag is set\n"),
            CompletedProcess([], 1, "", message.replace("devhot-site", "other-user")),
            CompletedProcess([], 0, "User devhot-site may run the following commands", ""),
        ):
            self.assertFalse(denied(result))

    def test_daemon_descriptor_tables_reject_tcp_and_unknown_endpoints(self):
        policy = importlib.import_module("host_probe").socket_policy
        tcp = "sl local_address rem_address st tx_queue rx_queue tr tm retr uid timeout inode\n"
        unix = "Num RefCount Protocol Flags Type St Inode Path\n"
        expected = "/run/user/1001/docker.sock"
        unix += "000: 2 0 00010000 0001 01 42 " + expected + "\n"
        self.assertTrue(policy({"42"}, [tcp, tcp], unix, expected))
        ipc = "/run/user/1001/docker/libnetwork/0123456789ab.sock"
        internal = unix + "000: 2 0 00010000 0001 01 43 " + ipc + "\n"
        self.assertTrue(
            policy(
                {"42", "43"},
                [tcp, tcp],
                internal,
                expected,
                internal_socket_check=lambda path: path == ipc,
            )
        )
        self.assertFalse(policy({"42", "43"}, [tcp, tcp], internal, expected))
        self.assertFalse(
            policy(
                {"42", "43"},
                [tcp, tcp],
                internal.replace(ipc, "/run/user/1001/extra.sock"),
                expected,
                internal_socket_check=lambda path: True,
            )
        )
        tcp_listener = "0: 00000000:0945 00000000:0000 0A 0:0 00:0 0 1001 0 43\n"
        self.assertFalse(policy({"42", "43"}, [tcp + tcp_listener, tcp], unix, expected))
        self.assertFalse(policy({"42", "43"}, [tcp, tcp + tcp_listener], unix, expected))
        self.assertFalse(policy({"42"}, ["unreadable", tcp], unix, expected))
        self.assertFalse(policy(set(), [tcp, tcp], unix, expected))
        self.assertFalse(
            policy({"42"}, [tcp, tcp], unix.replace(expected, "/run/docker.sock"), expected)
        )

    def test_live_observer_is_read_only_and_never_claims_the_synthetic_instance_is_ready(self):
        config = importlib.import_module("host_config").parse_config(instance())
        probe = importlib.import_module("host_probe").HostProbe(config)
        roots = (config.release_root, config.state_root, config.runtime_root)
        before = [p.exists() for p in roots]
        evidence = probe.collect()
        report = importlib.import_module("host_checks").assess_host(config, evidence)
        self.assertEqual(report["status"], "failed")
        self.assertEqual([p.exists() for p in roots], before)

    def test_complete_synthetic_host_passes_with_explicit_real_host_boundary(self):
        config = importlib.import_module("host_config").parse_config(instance())
        checks = importlib.import_module("host_checks")
        evidence = healthy_host()
        before = copy.deepcopy(evidence)
        report = checks.assess_host(config, evidence)
        self.assertEqual(report["status"], "passed")
        self.assertTrue(all(row["status"] == "passed" for row in report["checks"]))
        self.assertEqual(evidence, before)
        self.assertIn("firewall_and_client_access", report["requires_real_host_acceptance"])
        self.assertIn("restart_recovery", report["requires_real_host_acceptance"])
        self.assertIn("user_authorization", report["requires_real_host_acceptance"])


if __name__ == "__main__":
    unittest.main()
