"""Launch-chain and real namespace observations without privileged proc exe reads."""

import importlib
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
fixtures = importlib.import_module("host_fixtures")


class HostDaemonTests(unittest.TestCase):
    def test_effective_service_rejects_user_path_alternative_commands_and_environment(self):
        module = importlib.import_module("host_daemon")
        config = importlib.import_module("host_config").parse_config(fixtures.instance())
        argv = module.daemon_argv(config)
        value = (
            "{ path=/usr/bin/env ; argv[]=" + " ".join(argv) + " ; ignore_errors=no ; pid=123 ; }"
        )
        self.assertTrue(module.effective_start_matches(config, value))
        for changed in (
            value.replace("PATH=/usr/bin", "PATH=/home/user/bin"),
            value.replace(" -i ", " "),
            value + value,
            value.replace("--host=unix://", "--host=tcp://"),
            value.replace("/usr/bin/dockerd-rootless.sh", "/home/user/start.sh"),
        ):
            self.assertFalse(module.effective_start_matches(config, changed))
        self.assertIn("ConditionUser=devhot-site", module.daemon_unit(config))
        self.assertNotIn("NoNewPrivileges=yes", module.daemon_unit(config))
        site = importlib.import_module("host_config").unit_files(config)["devhot-site.service"]
        self.assertNotIn("NoNewPrivileges=yes", site)

    def test_nonleader_thread_children_are_included(self):
        children = importlib.import_module("host_daemon").process_children
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for tid, pids in (("123", ""), ("456", "789 790")):
                task = root / "task" / tid
                task.mkdir(parents=True)
                (task / "children").write_text(pids)
            self.assertEqual(children(root), {789, 790})

    def test_namespace_maps_require_actual_identity_and_assigned_subordinate_ranges(self):
        match = importlib.import_module("host_daemon").namespace_map_matches
        self.assertTrue(match("0 1001 1\n1 231072 65536\n", 1001, [(231072, 65536)]))
        self.assertFalse(
            match("0 1001 1\n1 0 1\n2 231072 65536\n", 1001, [(0, 1), (231072, 65536)])
        )
        for text in (
            "0 0 4294967295\n",
            "0 1002 1\n1 231072 65536\n",
            "0 1001 1\n1 900000 65536\n",
            "0 1001 1\n1 231072 100\n",
            "invalid",
            "0 1001 1\n2 231072 65536\n",
        ):
            self.assertFalse(match(text, 1001, [(231072, 65536)]))

    def test_numeric_subgid_subject_uses_uid_and_process_status_survives_dumpable_owner_change(
        self,
    ):
        module = importlib.import_module("host_daemon")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            subgid = root / "subgid"
            subgid.write_text("1001:231072:65536\n")
            self.assertEqual(
                importlib.import_module("host_probe").subids(subgid, "devhot-site", 1001),
                [(231072, 65536)],
            )
            # Directory owner is intentionally unrelated to the observed effective UID.
            (root / "status").write_text(
                "Name:\trootlesskit\nUid:\t1001\t1001\t1001\t1001\n"
                "CapEff:\t00000400\nCapPrm:\t00000400\n"
            )
            fields = ["S"] + ["0"] * 18 + ["12345"] + ["0"] * 8
            (root / "stat").write_text("123 (name with spaces) " + " ".join(fields))
            (root / "cmdline").write_bytes(b"rootlesskit\0--net=slirp4netns\0")
            observed = module.process_identity(root)
            self.assertEqual(observed["uid"], 1001)
            self.assertEqual(observed["start_ticks"], 12345)
            self.assertEqual(observed["argv"], ["rootlesskit", "--net=slirp4netns"])
            self.assertFalse((root / "exe").exists())


if __name__ == "__main__":
    unittest.main()
