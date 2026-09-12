"""Journal routing and observable compensation when its output stream disconnects."""

import importlib
import os
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "deploy"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


class HostJournalTests(unittest.TestCase):
    def test_plain_output_pipe_is_not_a_journal_connection(self):
        journal = importlib.import_module("host_journal")
        reader, writer = os.pipe()
        try:
            self.assertFalse(journal.is_journal_stream(writer))
        finally:
            os.close(reader)
            os.close(writer)

    def test_broken_journal_does_not_interrupt_real_rollback_but_returns_io_failure(self):
        fixture = importlib.import_module("test_deployment_controller").DeploymentControllerTests(
            methodName="runTest"
        )
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.controller.deploy(fixture.first)
        fixture.controller.deploy(fixture.second)
        commands = importlib.import_module("host_commands")
        reader, writer = os.pipe()
        os.close(reader)
        stream = os.fdopen(writer, "w")
        self.addCleanup(lambda: None if stream.closed else stream.close())
        events = commands.Events(stream)
        fixture.controller.event = events

        class Runtime:
            def check_nginx(self):
                pass

            def dispose(self):
                pass

        app = commands.HostCommands(
            fixture.controller, Runtime(), Runtime(), events, lambda: fixture.second
        )
        result = app.execute("rollback", fixture.first)
        self.assertEqual(result["status"], "success")
        self.assertEqual(fixture.read_http("/"), "first public version")
        self.assertEqual(fixture.store.current_sha(), fixture.first)
        self.assertTrue(events.write_failed)
        journal = importlib.import_module("host_journal")
        self.assertEqual(journal.finish_events(events, 0), journal.JOURNAL_IO_ERROR)
