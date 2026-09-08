import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it(
  "verifies deployment failures and recovery through real Git, HTTP, files and competing processes",
  { timeout: 30_000 },
  () => {
    const result = spawnSync(
      "python3",
      ["tests/deployment/test_deployment_controller.py"],
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
