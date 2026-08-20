import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPublicationGateFixture,
  type PublicationGateFixture,
} from "../support/publication-gate-fixture";

const projectRoot = process.cwd();
const workflowPath = join(projectRoot, ".github", "workflows", "publication-gate.yml");
const repositoryWorkflowPath = join(
  projectRoot,
  ".github",
  "workflows",
  "repository-gate.yml",
);
type CandidateMutation = Parameters<typeof createPublicationGateFixture>[0];

describe("publication-gate workflow", () => {
  const fixtures: PublicationGateFixture[] = [];

  const createTrackedFixture = async (
    mutateCandidate: CandidateMutation,
  ): Promise<PublicationGateFixture> => {
    const fixture = await createPublicationGateFixture(mutateCandidate);
    fixtures.push(fixture);
    return fixture;
  };

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it("declares one stable read-only publication check", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toMatch(/^name: publication-gate$/m);
    expect(workflow).toMatch(
      /^on:\n  push:\n    branches:\n      - "publication\/\*\*"$/m,
    );
    expect(workflow).toMatch(/^permissions:\n  contents: read\n\njobs:/m);
    expect(workflow).not.toMatch(/^\s+[a-z-]+: write$/m);
    expect(workflow).toMatch(/^  publication-gate:\n    name: publication-gate$/m);
    expect(workflow).not.toContain("${{ secrets.");
    expect(workflow).not.toMatch(/\b(?:git push|gh api)\b/);
  });

  it("runs the fixed install and single gate only after the trusted boundary", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const boundaryIndex = workflow.indexOf("name: Verify trusted publication boundary");
    const setupNodeIndex = workflow.indexOf("name: Set up the fixed Node runtime");
    const installIndex = workflow.indexOf("name: Install locked dependencies");
    const repositoryGateIndex = workflow.indexOf("name: Run the single repository gate");

    expect(boundaryIndex).toBeGreaterThan(0);
    expect(setupNodeIndex).toBeGreaterThan(boundaryIndex);
    expect(installIndex).toBeGreaterThan(setupNodeIndex);
    expect(repositoryGateIndex).toBeGreaterThan(installIndex);
    expect(workflow).toContain('node-version: "24.19.0"');
    expect(workflow).toContain("node-version-mismatch");
    expect(workflow.match(/^\s+run: npm ci$/gm)).toHaveLength(1);
    expect(workflow.match(/npm run gate/g)).toHaveLength(1);
    expect(workflow).toContain("repository-gate-failed");

    const beforeBoundary = workflow.slice(0, boundaryIndex);
    expect(beforeBoundary).not.toMatch(/^\s+run:/m);
    expect(beforeBoundary).not.toContain("uses: ./");
    const externalActions = [...workflow.matchAll(/^\s+uses: ([^@\s]+)@([^\s]+)/gm)];
    expect(externalActions).toHaveLength(2);
    for (const action of externalActions) {
      expect(action[2], action[1]).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it("provides Bash and Git before repository fixture tests run", async () => {
    const workflow = await readFile(repositoryWorkflowPath, "utf8");
    const fixtureRuntimeInstallIndex = workflow.indexOf(
      "run: apk add --no-cache bash git",
    );
    const dependencyInstallIndex = workflow.indexOf("run: npm ci");
    const repositoryGateIndex = workflow.indexOf("run: npm run gate");

    expect(fixtureRuntimeInstallIndex).toBeGreaterThan(0);
    expect(dependencyInstallIndex).toBeGreaterThan(fixtureRuntimeInstallIndex);
    expect(repositoryGateIndex).toBeGreaterThan(dependencyInstallIndex);
  });

  it("accepts a single-parent candidate that changes only regular site input", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await mkdir(join(root, "site-input", "data"), { recursive: true });
      await writeFile(
        join(root, "site-input", "data", "candidate.json"),
        '{"publication":"candidate"}\n',
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("publication-boundary-ok");
  });

  it("rejects a candidate that changes builder code", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(
        join(root, "src", "candidate.ts"),
        'throw new Error("candidate code must not run");\n',
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unauthorized-path:src/candidate.ts");
  });

  it("reports a workflow rewrite as an unauthorized path", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(
        join(root, ".github", "workflows", "publication-gate.yml"),
        "name: candidate-controlled-gate\n",
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "unauthorized-path:.github/workflows/publication-gate.yml",
    );
  });

  it("reports lockfile drift before dependency installation", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(join(root, "package-lock.json"), '{"candidate":true}\n');
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unauthorized-path:package-lock.json");
  });

  it("rejects executable files inside the publication input", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      const executablePath = join(root, "site-input", "data", "candidate.sh");
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
      await chmod(executablePath, 0o755);
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "unsafe-entry:100755 blob site-input/data/candidate.sh",
    );
  });

  it("rejects publication paths outside the safe portable alphabet", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(
        join(root, "site-input", "data", "candidate draft.json"),
        '{"publication":"candidate"}\n',
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "illegal-path:site-input/data/candidate\\ draft.json",
    );
  });

  it("parses newline-bearing paths as one NUL-delimited record", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(
        join(root, "site-input", "data", "candidate\nname.json"),
        '{"publication":"candidate"}\n',
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("illegal-path:");
    expect(result.stdout).not.toContain("candidate\nname.json");
  });

  it("checks a rename source as well as its publication target", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await rename(
        join(root, "src", "index.ts"),
        join(root, "site-input", "data", "index.ts"),
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unauthorized-path:src/index.ts");
  });

  it("checks an unchanged copy source as well as its publication target", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await copyFile(
        join(root, "src", "index.ts"),
        join(root, "site-input", "data", "index.ts"),
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unauthorized-path:src/index.ts");
  });

  it("rejects symlinks inside the publication input", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await symlink(
        "../../../src/index.ts",
        join(root, "site-input", "data", "candidate-link"),
      );
    });

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "unsafe-entry:120000 blob site-input/data/candidate-link",
    );
  });

  it("rejects a candidate whose protected-main parent has gone stale", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(
        join(root, "site-input", "data", "candidate.json"),
        '{"publication":"candidate"}\n',
      );
    });
    await fixture.advanceProtectedMain();

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("stale-base:");
  });

  it("rejects gitlinks inside the publication input", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(
        join(root, "site-input", "data", "candidate.json"),
        '{"publication":"candidate"}\n',
      );
    });
    await fixture.addGitlink();

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "unsafe-entry:160000 commit site-input/data/candidate-gitlink",
    );
  });

  it("rejects a candidate commit with more than one parent", async () => {
    const fixture = await createTrackedFixture(async (root) => {
      await writeFile(
        join(root, "site-input", "data", "candidate.json"),
        '{"publication":"candidate"}\n',
      );
    });
    await fixture.makeMergeCandidate();

    const result = await fixture.runBoundary();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("invalid-parent-count:3");
  });
});
