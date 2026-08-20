import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

export interface PublicationGateResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PublicationGateFixture {
  readonly root: string;
  readonly candidateSha: string;
  addGitlink(): Promise<void>;
  advanceProtectedMain(): Promise<void>;
  makeMergeCandidate(): Promise<void>;
  runBoundary(): Promise<PublicationGateResult>;
  cleanup(): Promise<void>;
}

type CandidateMutation = (workingRoot: string) => Promise<void>;

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
};

const extractBoundaryScript = async (): Promise<string> => {
  const workflow = await readFile(
    join(projectRoot, ".github", "workflows", "publication-gate.yml"),
    "utf8",
  );
  const startMarker = "          # publication-boundary:start\n";
  const endMarker = "          # publication-boundary:end";
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker);
  if (start < 0 || end <= start) {
    throw new Error("publication boundary script is not embedded in the workflow");
  }
  return workflow
    .slice(start + startMarker.length, end)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
};

export const createPublicationGateFixture = async (
  mutateCandidate: CandidateMutation,
): Promise<PublicationGateFixture> => {
  const root = await mkdtemp(join(tmpdir(), "devhot-publication-gate-"));
  const originRoot = join(root, "origin.git");
  const workingRoot = join(root, "working");

  await mkdir(workingRoot);
  await git(root, "init", "--bare", "--initial-branch=main", originRoot);
  await git(workingRoot, "init", "--initial-branch=main");
  await git(workingRoot, "config", "user.name", "Publication Gate Fixture");
  await git(workingRoot, "config", "user.email", "fixture@devhot.invalid");
  await mkdir(join(workingRoot, "site-input", "data"), { recursive: true });
  await mkdir(join(workingRoot, ".github", "workflows"), { recursive: true });
  await mkdir(join(workingRoot, "src"), { recursive: true });
  await writeFile(
    join(workingRoot, "site-input", "manifest.json"),
    '{"schemaVersion":1}\n',
  );
  await writeFile(join(workingRoot, "package-lock.json"), "{}\n");
  await writeFile(join(workingRoot, "src", "index.ts"), "export {};\n");
  await writeFile(
    join(workingRoot, ".github", "workflows", "publication-gate.yml"),
    "name: trusted-publication-gate\n",
  );
  await git(
    workingRoot,
    "add",
    "--",
    "site-input",
    "package-lock.json",
    "src",
    ".github",
  );
  await git(workingRoot, "commit", "-m", "fixture: establish protected main");
  await git(workingRoot, "remote", "add", "origin", originRoot);
  await git(workingRoot, "push", "-u", "origin", "main");
  await git(workingRoot, "switch", "-c", "publication/fixture");

  await mutateCandidate(workingRoot);
  await git(workingRoot, "add", "--all");
  await git(workingRoot, "commit", "-m", "fixture: create publication candidate");
  let candidateSha = await git(workingRoot, "rev-parse", "HEAD");

  return {
    root: workingRoot,
    get candidateSha() {
      return candidateSha;
    },
    async addGitlink() {
      await git(
        workingRoot,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${candidateSha},site-input/data/candidate-gitlink`,
      );
      await git(workingRoot, "commit", "--amend", "--no-edit");
      candidateSha = await git(workingRoot, "rev-parse", "HEAD");
    },
    async advanceProtectedMain() {
      await git(workingRoot, "switch", "main");
      await mkdir(join(workingRoot, "site-input", "data"), { recursive: true });
      await writeFile(
        join(workingRoot, "site-input", "data", "protected-main.json"),
        '{"publication":"advanced-main"}\n',
      );
      await git(workingRoot, "add", "--", "site-input/data/protected-main.json");
      await git(workingRoot, "commit", "-m", "fixture: advance protected main");
      await git(workingRoot, "push", "origin", "main");
      await git(workingRoot, "switch", "publication/fixture");
    },
    async makeMergeCandidate() {
      await git(workingRoot, "switch", "-c", "fixture/side", "main");
      await mkdir(join(workingRoot, "site-input", "data"), { recursive: true });
      await writeFile(
        join(workingRoot, "site-input", "data", "side.json"),
        '{"publication":"side"}\n',
      );
      await git(workingRoot, "add", "--", "site-input/data/side.json");
      await git(workingRoot, "commit", "-m", "fixture: create second parent");
      await git(workingRoot, "switch", "publication/fixture");
      await git(
        workingRoot,
        "merge",
        "--no-ff",
        "fixture/side",
        "-m",
        "fixture: create merge candidate",
      );
      candidateSha = await git(workingRoot, "rev-parse", "HEAD");
    },
    async runBoundary() {
      const script = await extractBoundaryScript();
      const result = spawnSync("bash", ["-c", script], {
        cwd: workingRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/publication/fixture",
          GITHUB_SHA: candidateSha,
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};
