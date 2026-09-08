import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("verifies atomic release storage through real filesystem and CLI observations", () => {
  const result = spawnSync("python3", ["tests/deployment/test_release_store.py"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = result.stdout + result.stderr;
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toMatch(/Ran [1-9]\d* tests?/);
  expect(output).not.toContain("skipped");
});
