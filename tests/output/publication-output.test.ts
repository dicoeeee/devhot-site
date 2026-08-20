import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import { copyDeclaredAssets } from "../../tools/copy-assets";
import { verifyDistribution } from "../../tools/verify-dist";
import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const distRoot = join(projectRoot, "dist");
let expectedPublicationId = "";
let expectedRoutes: string[] = [];
let inputLogoPath = "";
let outputLogoPath = "";
let defaultDomainOutputSegments: string[] = [];

describe("publication output", () => {
  beforeAll(async () => {
    const input = await validatePublicationInput(join(projectRoot, "site-input"));
    expectedPublicationId = input.publicationId;
    expectedRoutes = [
      "/",
      ...(input.home.schemaVersion === 1
        ? [input.home.domain.url]
        : input.home.domains.map((home) => home.domain.url)),
      ...input.insights.map((insight) => `/insights/${insight.id}/`),
      ...input.sources.map((source) => `/sources/${source.id}/`),
    ].sort();
    const logo = input.assets.get(input.home.masthead.logoAssetPath);
    if (!logo) throw new Error("validated masthead logo is unavailable");
    inputLogoPath = logo.fullPath;
    outputLogoPath = join(distRoot, "media", "sha256", `${logo.sha256}.png`);
    let defaultDomainUrl: string | undefined;
    if (input.home.schemaVersion === 1) {
      defaultDomainUrl = input.home.domain.url;
    } else {
      const defaultDomain = input.home.defaultDomain;
      defaultDomainUrl = input.home.domains.find(
        (domainHome) => domainHome.domain.id === defaultDomain,
      )?.domain.url;
    }
    if (!defaultDomainUrl) throw new Error("validated default domain is unavailable");
    defaultDomainOutputSegments = defaultDomainUrl.split("/").filter(Boolean);
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

  it("copies the declared masthead bytes and verifies a self-contained distribution", async () => {
    const inputLogo = await readFile(inputLogoPath);
    const outputLogo = await readFile(outputLogoPath);

    expect(outputLogo.equals(inputLogo)).toBe(true);
    await expect(verifyDistribution({ distRoot })).resolves.toEqual(
      expect.objectContaining({
        publicationId: expectedPublicationId,
        routes: expectedRoutes,
      }),
    );
  });

  it.each(["https://example.com/runtime.js", "//cdn.example/runtime.js"])(
    "rejects a page that introduces the third-party runtime asset %s",
    async (runtimeUrl) => {
      const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
      await cp(distRoot, tamperedDist, { recursive: true });
      await appendFile(
        join(tamperedDist, ...defaultDomainOutputSegments, "index.html"),
        `<script src="${runtimeUrl}"></script>`,
      );

      await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
        "external runtime dependency",
      );
    },
  );
});
