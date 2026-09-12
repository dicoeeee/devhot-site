import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it(
  "checks host configuration, commands, Git export and isolation with positive and negative evidence",
  { timeout: 30_000 },
  () => {
    const result = spawnSync(
      "python3",
      ["-m", "unittest", "discover", "-s", "tests/deployment", "-p", "test_host_*.py"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = result.stdout + result.stderr;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Ran [1-9]\d* tests?/);
    expect(output).not.toContain("skipped");
  },
);
