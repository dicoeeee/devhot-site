"""Check production Docker arguments and actual-container inspection policy."""

import copy
import importlib
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
fixtures = importlib.import_module("host_fixtures")


class HostDockerTests(unittest.TestCase):
    def test_builder_mounts_only_source_readonly_and_pins_image(self):
        module = importlib.import_module("host_docker")
        config = importlib.import_module("host_config").parse_config(fixtures.instance())
        args = module.builder_arguments(
            config, "/var/lib/devhot-site/job/source", "a" * 40, "0123456789abcdef"
        )
        mounts = [args[index + 1] for index, arg in enumerate(args) if arg == "--mount"]
        self.assertEqual(
            mounts, ["type=bind,source=/var/lib/devhot-site/job/source,target=/source,readonly"]
        )
        self.assertNotIn("/run/user/1001/docker.sock", " ".join(args))
        self.assertNotIn("--privileged", args)
        self.assertIn(module.NODE_IMAGE, args)
        self.assertIn("--log-driver=none", args)
        self.assertIn("--memory=4g", args)
        self.assertIn("--pids-limit=512", args)
        self.assertIn("--cap-drop=NET_RAW", args)

    def test_nginx_policy_rejects_extra_mount_privilege_wildcard_and_wrong_image(self):
        module = importlib.import_module("host_docker")
        config = importlib.import_module("host_config").parse_config(fixtures.instance())
        plan = importlib.import_module("host_config").compose_plan(config)["services"]["nginx"]
        value = {
            "Config": {
                "Image": plan["image"],
                "User": "101:101",
                "Entrypoint": ["nginx"],
                "Cmd": ["-g", "daemon off;"],
                "Labels": {"devhot.site.managed": "1"},
            },
            "State": {"Running": True},
            "HostConfig": {
                "ReadonlyRootfs": True,
                "Privileged": False,
                "CapAdd": None,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "PidMode": "",
                "IpcMode": "private",
                "NetworkMode": "devhot-site_service",
                "Binds": None,
                "Devices": [],
                "VolumesFrom": None,
                "Tmpfs": {"/tmp": "rw,nosuid,noexec,size=64m,mode=1777"},
                "PortBindings": {"8080/tcp": [{"HostIp": config.lan_ipv4, "HostPort": "80"}]},
                "RestartPolicy": {"Name": "unless-stopped"},
                "LogConfig": {"Type": "journald", "Config": {"tag": "devhot-site-nginx"}},
            },
            "Mounts": [
                {
                    "Type": "bind",
                    "Source": mount["source"],
                    "Destination": mount["target"],
                    "RW": False,
                }
                for mount in plan["volumes"]
            ],
            "NetworkSettings": {
                "Networks": {"devhot-site_service": {}},
                "Ports": {"8080/tcp": [{"HostIp": config.lan_ipv4, "HostPort": "80"}]},
            },
        }
        self.assertTrue(module.nginx_matches(config, value))
        cases = [
            (("Config", "Image"), "nginx:latest"),
            (("Config", "User"), "0"),
            (("HostConfig", "Privileged"), True),
            (("HostConfig", "CapAdd"), ["SYS_ADMIN"]),
            (("HostConfig", "SecurityOpt"), []),
            (("HostConfig", "PidMode"), "host"),
            (
                ("HostConfig", "PortBindings"),
                {"8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "80"}]},
            ),
            (("NetworkSettings", "Networks"), {"host": {}}),
            (
                ("Mounts",),
                value["Mounts"]
                + [{"Type": "bind", "Source": "/state", "Destination": "/state", "RW": False}],
            ),
        ]
        for keys, replacement in cases:
            with self.subTest(keys=keys):
                item = copy.deepcopy(value)
                target = item
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = replacement
                self.assertFalse(module.nginx_matches(config, item))
        self.assertFalse(module.nginx_matches(config, {}))


if __name__ == "__main__":
    unittest.main()
