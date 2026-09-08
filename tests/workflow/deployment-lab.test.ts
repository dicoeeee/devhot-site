import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("runs the real lab outside the socket-free Node gate container on PR and main", async () => {
  const workflow = await readFile(".github/workflows/repository-gate.yml", "utf8");
  const lab = workflow.split("  deployment-lab:\n")[1];
  expect(lab).toBeDefined();
  expect(lab).toContain("name: deployment-lab");
  expect(lab).toContain("runs-on: ubuntu-latest");
  expect(lab).not.toContain("container:");
  expect(lab).toContain("run: npm ci");
  expect(lab).toContain("npm run deployment:lab");
  expect(lab).toContain("ref: ${{ github.event.pull_request.head.sha || github.sha }}");
  expect(lab).not.toContain("continue-on-error");
  expect(lab).not.toContain("secrets.");
  expect(lab).toContain("Record deployment lab evidence");
});

it("uses the single gate and existing immutable Node identity inside real builders", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const images = await readFile("deploy/lab_docker.py", "utf8");
  const lab = await readFile("deploy/lab.py", "utf8");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const digest = dockerfile.match(/node:24\.19\.0-bookworm@(sha256:[a-f0-9]{64})/)?.[1];
  expect(digest).toBeDefined();
  expect(images).toContain(digest);
  expect(pkg.scripts["deployment:lab"]).toBe("python3 deploy/lab.py");
  expect(lab).toContain("npm ci\n");
  expect(lab).toContain("npm run gate\n");
  expect(lab).toContain("DEVHOT_SITE_BUILD_SHA");
  expect(lab).not.toContain("--privileged");
  expect(lab).not.toContain("/var/run/docker.sock:/");
});
