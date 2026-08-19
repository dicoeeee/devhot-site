import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import { copyDeclaredAssets } from "../../tools/copy-assets";
import { verifyDistribution } from "../../tools/verify-dist";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const distRoot = join(projectRoot, "dist");

describe("publication output", () => {
  beforeAll(async () => {
    await rm(distRoot, { recursive: true, force: true });
    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: projectRoot },
    );
    await copyDeclaredAssets({
      inputRoot: join(projectRoot, "site-input"),
      distRoot,
    });
  });

  it("copies the original CIMC bytes and verifies a self-contained distribution", async () => {
    const inputLogo = await readFile(
      join(
        projectRoot,
        "site-input",
        "assets",
        "sha256",
        "73bc08f1a558271ed021a4f51fcc4a07d2850deea7cb592282ae0f9d5a110c89.png",
      ),
    );
    const outputLogo = await readFile(
      join(
        distRoot,
        "media",
        "sha256",
        "73bc08f1a558271ed021a4f51fcc4a07d2850deea7cb592282ae0f9d5a110c89.png",
      ),
    );

    expect(outputLogo.equals(inputLogo)).toBe(true);
    await expect(verifyDistribution({ distRoot })).resolves.toEqual(
      expect.objectContaining({
        publicationId: "fixture-2026-08-19",
        routes: ["/software-engineering/"],
      }),
    );
  });

  it.each(["https://example.com/runtime.js", "//cdn.example/runtime.js"])(
    "rejects a page that introduces the third-party runtime asset %s",
    async (runtimeUrl) => {
      const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
      await cp(distRoot, tamperedDist, { recursive: true });
      await appendFile(
        join(tamperedDist, "software-engineering", "index.html"),
        `<script src="${runtimeUrl}"></script>`,
      );

      await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
        "external runtime dependency",
      );
    },
  );
});
