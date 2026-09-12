"""Rootless package contracts at the configuration and operator interfaces."""

import importlib
import json
import pathlib
import sys
import tempfile
import unittest

PROJECT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "deploy"))


def instance():
    return {
        "schemaVersion": 1,
        "account": "devhot-site",
        "uid": 1001,
        "gid": 1001,
        "lan_ipv4": "192.168.50.10",
        "allowed_ipv4_cidrs": ["192.168.50.0/24"],
        "release_root": "/srv/devhot-site",
        "state_root": "/var/lib/devhot-site",
        "tool_root": "/opt/devhot-site",
        "rootlesskit": {
            "path": "/usr/bin/rootlesskit",
            "sha256": "a" * 64,
            "device": 1,
            "inode": 12345,
        },
    }


class HostPackageTests(unittest.TestCase):
    def test_rendered_package_has_persistent_user_timer_but_no_activation(self):
        package = importlib.import_module("host_config")
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "package"
            package.write_package(package.parse_config(instance()), root)
            timer = (root / "systemd/user/devhot-site.timer").read_text()
            service = (root / "systemd/user/devhot-site.service").read_text()
            self.assertIn("OnCalendar=*-*-* 02:00:00 Asia/Shanghai", timer)
            self.assertIn("Persistent=true", timer)
            self.assertIn("Unit=devhot-site.service", timer)
            self.assertIn("ConditionUser=devhot-site", service)
            self.assertIn("Requires=docker.service", service)
            self.assertIn("Type=oneshot", service)
            self.assertIn("StandardOutput=journal", service)
            self.assertIn("StandardError=journal", service)
            self.assertIn(" check-main", service)
            self.assertNotIn("User=root", service)
            self.assertEqual(list(root.rglob("*.wants")), [])
            self.assertFalse(any(p.is_symlink() for p in root.rglob("*")))
            self.assertEqual(
                json.loads((root / "compose.json").read_text()),
                package.compose_plan(package.parse_config(instance())),
            )
            before = (root / "compose.json").read_bytes()
            with self.assertRaises(FileExistsError):
                package.write_package(package.parse_config(instance()), root)
            self.assertEqual((root / "compose.json").read_bytes(), before)

    def test_configuration_rejects_privilege_network_path_and_secret_overrides(self):
        package = importlib.import_module("host_config")
        cases = [("lan_ipv4", value) for value in ("0.0.0.0", "127.0.0.1", "8.8.8.8", "::1")]
        cases += [
            ("uid", 0),
            ("uid", True),
            ("gid", 0),
            ("account", "root"),
            ("schemaVersion", True),
            ("release_root", "/srv/site/../other"),
            ("release_root", "/etc"),
            ("state_root", "/srv/devhot-site/state"),
            ("tool_root", "/opt/site%U"),
            ("allowed_ipv4_cidrs", ["0.0.0.0/0"]),
            ("allowed_ipv4_cidrs", []),
            ("token", "PRIVATE_SENTINEL"),
            ("docker_host", "tcp://127.0.0.1:2375"),
            ("nginx_image", "nginx:latest"),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                raw = instance()
                raw[key] = value
                with self.assertRaisesRegex(ValueError, "^deployment_invalid_host_config$"):
                    package.parse_config(raw)
        for key, value in [
            ("path", "/home/user/rootlesskit"),
            ("path", "/usr/bin/sh"),
            ("sha256", "0" * 64),
            ("inode", True),
            ("device", -1),
        ]:
            with self.subTest(rootlesskit=key):
                raw = instance()
                raw["rootlesskit"][key] = value
                with self.assertRaisesRegex(ValueError, "^deployment_invalid_host_config$"):
                    package.parse_config(raw)

    def test_plan_pins_nonroot_readonly_nginx_to_only_the_approved_address(self):
        package = importlib.import_module("host_config")
        config = package.parse_config(instance())
        plan = package.compose_plan(config)
        nginx = plan["services"]["nginx"]
        self.assertEqual(
            nginx["ports"],
            [{"target": 8080, "published": "80", "host_ip": "192.168.50.10", "protocol": "tcp"}],
        )
        self.assertEqual(nginx["user"], "101:101")
        self.assertTrue(nginx["read_only"])
        self.assertEqual(nginx["cap_drop"], ["ALL"])
        self.assertEqual(nginx["security_opt"], ["no-new-privileges:true"])
        self.assertIn(
            "@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49",
            nginx["image"],
        )
        # Docker does not publish host ports for an internal-only network.
        self.assertFalse(plan["networks"]["service"]["internal"])
        mounts = {m["target"]: m for m in nginx["volumes"]}
        self.assertEqual(
            set(mounts),
            {
                "/usr/share/nginx",
                "/etc/nginx/conf.d/default.conf",
                "/etc/nginx/deploy/security-headers.conf",
            },
        )
        self.assertEqual(mounts["/usr/share/nginx"]["source"], "/srv/devhot-site/releases")
        self.assertTrue(all(m["read_only"] for m in mounts.values()))
        self.assertNotIn("docker.sock", json.dumps(nginx))
        self.assertNotIn("/var/lib/devhot-site", json.dumps(nginx))


if __name__ == "__main__":
    unittest.main()
