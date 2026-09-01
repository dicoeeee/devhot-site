import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import { copyDeclaredAssets } from "../../tools/copy-assets";
import { verifyDistribution } from "../../tools/verify-dist";
import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
import { writePublicationFixture } from "../support/publication-fixture";
import { prepareStaticBuild } from "../support/static-build";

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
      ...(input.topics
        ? [
            ...new Set(
              input.topics.topics.flatMap((topic) =>
                topic.domains.map((domain) => `/${domain}/topics/`),
              ),
            ),
            ...input.topics.topics.flatMap((topic) =>
              Array.from(
                { length: Math.ceil(topic.currentMemberInsightIds.length / 5) },
                (_, index) =>
                  index === 0
                    ? `/topics/${topic.id}/`
                    : `/topics/${topic.id}/page/${index + 1}/`,
              ),
            ),
            ...(input.topics.schemaVersion === 2
              ? input.topics.tags.flatMap((tag) =>
                  Array.from(
                    { length: Math.max(1, Math.ceil(tag.relatedInsightIds.length / 5)) },
                    (_, index) =>
                      index === 0
                        ? `/tags/${tag.type}/${tag.name}/`
                        : `/tags/${tag.type}/${tag.name}/page/${index + 1}/`,
                  ),
                )
              : []),
          ]
        : []),
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

  it("declares and verifies the stable first page of an empty topic", async () => {
    const fixture = await writePublicationFixture({
      emptyTopic: true,
      topicJudgment: "none",
    });
    const buildRoot = await prepareStaticBuild(fixture.root);
    const emptyTopicDist = join(buildRoot, "dist");
    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: buildRoot },
    );
    await copyDeclaredAssets({
      inputRoot: fixture.root,
      distRoot: emptyTopicDist,
    });

    const metadata = await verifyDistribution({ distRoot: emptyTopicDist });

    expect(metadata.routes).toContain(`/topics/${fixture.topicId}/`);
    expect(metadata.routes).not.toContain(`/topics/${fixture.topicId}/page/2/`);
    expect(metadata.routes).toContain("/software-engineering/topics/");
    expect(metadata.routes).toContain("/model-research/topics/");
  });

  it("copies and verifies a manifest-declared Mermaid SVG mechanism asset", async () => {
    const fixture = await writePublicationFixture({
      evidenceReadingContract: true,
      mermaidMechanismContract: true,
    });
    const buildRoot = await prepareStaticBuild(fixture.root);
    const svgDist = join(buildRoot, "dist");
    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: buildRoot },
    );
    await copyDeclaredAssets({ inputRoot: fixture.root, distRoot: svgDist });

    const metadata = await verifyDistribution({ distRoot: svgDist });

    expect(metadata.assets).toContainEqual(
      expect.objectContaining({
        sha256: fixture.mermaidSha256,
        mediaType: "image/svg+xml",
        url: `/media/sha256/${fixture.mermaidSha256}.svg`,
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
