import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
      ...(input.timeline ? ["/timeline/"] : []),
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

  it("publishes release metadata and desensitized maintenance JSON only", async () => {
    const release = JSON.parse(
      await readFile(join(distRoot, "release.json"), "utf8"),
    ) as Record<string, unknown>;
    const reminders = JSON.parse(
      await readFile(join(distRoot, "maintenance", "reminders.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(release).toMatchObject({
      schemaVersion: 1,
      publicationId: expectedPublicationId,
    });
    expect(typeof release["generatedAt"]).toBe("string");
    expect(reminders).toEqual({ schemaVersion: 1, reminders: [] });
    expect(existsSync(join(distRoot, "maintenance", "index.html"))).toBe(false);
  });

  it.each([
    ['<div onclick="steal()">x</div>', "inline event handler attribute"],
    ["<div onclick=steal()>x</div>", "inline event handler attribute"],
    ["<script>alert(1)</script>", "inline executable script"],
    ["<script>if (1 < 2) alert(1)</script>", "inline executable script"],
    ["<style>body{}</style>", "inline style block"],
    ['<div style="color:red">x</div>', "inline style attribute"],
    ["<div style=color:red>x</div>", "inline style attribute"],
    [
      '<link rel="stylesheet" href="https://example.com/runtime.css">',
      "external runtime dependency",
    ],
    [
      '<link rel="stylesheet" href="//cdn.example.com/runtime.css">',
      "external runtime dependency",
    ],
    [
      '<script src="https://example.com/runtime.js"></script>',
      "external runtime dependency",
    ],
    ['<iframe src="https://example.com/frame"></iframe>', "external runtime dependency"],
    [
      '<object data="https://example.com/movie.swf"></object>',
      "external runtime dependency",
    ],
    ['<video src="https://example.com/v.mp4"></video>', "external runtime dependency"],
    ['<embed src="https://example.com/flash.swf">', "external runtime dependency"],
    [
      '<img src="/ok.png" srcset="https://cdn.example.com/x.png 2x">',
      "external runtime dependency",
    ],
    [
      '<link rel="modulepreload" href="https://cdn.example.com/m.js">',
      "external runtime dependency",
    ],
    [
      '<link rel="preload" as="font" href="https://cdn.example.com/f.woff2" crossorigin>',
      "external runtime dependency",
    ],
    [
      "<script>navigator.serviceWorker.register('/sw.js')</script>",
      "inline executable script",
    ],
  ])("rejects distribution HTML that contains %s", async (payload, expectedError) => {
    const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(
      join(tamperedDist, ...defaultDomainOutputSegments, "index.html"),
      payload,
    );

    await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
      expectedError,
    );
  });

  it("rejects a distributed script that registers a service worker", async () => {
    const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(
      join(tamperedDist, "scripts", "timeline.js"),
      "\nnavigator.serviceWorker.register('/offline.js');\n",
    );

    await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
      "service worker registration found in scripts/timeline.js",
    );
  });

  it.each([
    '\nnavigator.sendBeacon("https://example.com/collect", "x");\n',
    "\nconst socket = new WebSocket('wss://example.com/socket');\n",
    "\nconst source = new EventSource('https://example.com/stream');\n",
    "\nconst xhr = new XMLHttpRequest(); xhr.open('GET', 'https://example.com/api');\n",
    "\nconst worker = new Worker('https://example.com/worker.js');\n",
    "\nconst shared = new SharedWorker('https://example.com/shared.js');\n",
    "\nfetch('//cdn.example.com/fragment');\n",
    "\nconst beacon = navigator.sendBeacon('http://example.com/track', 'y');\n",
    "\nconst ws = new WebSocket('ws://example.com/socket');\n",
  ])(
    "rejects a distributed script that opens a third-party connection via %s",
    async (payload) => {
      const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
      await cp(distRoot, tamperedDist, { recursive: true });
      await appendFile(join(tamperedDist, "scripts", "timeline.js"), payload);

      await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
        "external runtime dependency found in scripts/timeline.js",
      );
    },
  );

  it("still allows same-origin relative URLs in distributed scripts", async () => {
    const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(
      join(tamperedDist, "scripts", "timeline.js"),
      "\nfetch('/timeline/fragments/software-engineering/day/2026-08-30.json');\n",
    );

    await expect(verifyDistribution({ distRoot: tamperedDist })).resolves.toEqual(
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });

  it("rejects a release.json that drifts from the publication metadata", async () => {
    const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
    await cp(distRoot, tamperedDist, { recursive: true });
    await writeFile(
      join(tamperedDist, "release.json"),
      `${JSON.stringify({ schemaVersion: 1, publicationId: "other", buildSha: "0".repeat(40), generatedAt: "2026-01-01T00:00:00Z" })}\n`,
    );

    await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
      "release metadata is invalid",
    );
  });

  it("rejects maintenance state that publishes reader HTML", async () => {
    const tamperedDist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(join(tamperedDist, "maintenance", "index.html"), "<html></html>");

    await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
      "distribution HTML routes differ from publication metadata",
    );
  });
});
