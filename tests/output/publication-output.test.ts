import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { copyDeclaredAssets } from "../../tools/copy-assets";
import { listSafeFiles } from "../../src/infrastructure/list-safe-files";
import { verifyDistribution } from "../../tools/verify-dist";

// 记录本测试文件创建的全部 tamperedDist 目录；teardown 统一回收，
// 清理失败不得静默（不按全局前缀删除历史目录）。
const createdTempDists: string[] = [];
const newTamperedDist = async (): Promise<string> => {
  const dist = await mkdtemp(join(tmpdir(), "devhot-site-dist-"));
  createdTempDists.push(dist);
  return dist;
};
// fixture root（devhot-site-input-*）与 build root（devhot-site-page-*）
// 同样纳入回收：这两类目录在本测试文件中创建后没有各自的清理路径。
const createdTempRoots: string[] = [];
const trackedBuildRoot = async (prepare: () => Promise<string>): Promise<string> => {
  const root = await prepare();
  createdTempRoots.push(root);
  return root;
};

afterEach(async () => {
  const failures: Error[] = [];
  while (createdTempRoots.length > 0) {
    const root = createdTempRoots.pop()!;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error as Error);
    }
  }
  while (createdTempDists.length > 0) {
    const dist = createdTempDists.pop()!;
    try {
      await rm(dist, { recursive: true, force: true });
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "publication-output temp cleanup failed");
  }
});
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
    createdTempRoots.push(fixture.root);
    const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));
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
    createdTempRoots.push(fixture.root);
    const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));
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
      const tamperedDist = await newTamperedDist();
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
    // HTML 脚本类型规则：空 type 与 JavaScript MIME 变体都是可执行脚本。
    ['<script type="">globalThis.__probe = true;</script>', "inline executable script"],
    [
      '<script type="text/ecmascript">globalThis.__probe = true;</script>',
      "inline executable script",
    ],
    [
      '<script type="application/ecmascript">globalThis.__probe = true;</script>',
      "inline executable script",
    ],
    [
      '<script type="text/jscript">globalThis.__probe = true;</script>',
      "inline executable script",
    ],
    [
      '<script type="text/javascript1.5">globalThis.__probe = true;</script>',
      "inline executable script",
    ],
    // 未知 type 不得默认当作数据块放行（保守按可执行处理）。
    [
      '<script type="application/x-unknown">globalThis.__probe = true;</script>',
      "inline executable script",
    ],
  ])("rejects distribution HTML that contains %s", async (payload, expectedError) => {
    const tamperedDist = await newTamperedDist();
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
    const tamperedDist = await newTamperedDist();
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
    "\nfetch('//cdn.example.com/fragment');\n",
    "\nconst beacon = navigator.sendBeacon('http://example.com/track', 'y');\n",
    "\nconst ws = new WebSocket('ws://example.com/socket');\n",
    "\nconst socket = new WebSocket(`wss://example.com/socket`);\n",
    '\nnavigator.sendBeacon(`https://example.com/collect`, "x");\n',
    "\nconst source = new EventSource(`https://example.com/stream`);\n",
    "\nconst xhr = new XMLHttpRequest(); xhr.open('GET', `https://example.com/api`);\n",
    "\nfetch(`HTTPS://EXAMPLE.COM/fragment`);\n",
    "\nconst ws = new WebSocket('WSS://example.com/socket');\n",
    "\nfetch(`//cdn.example.com/${'fragment'}`);\n",
    "\nconst s = `https://example.com/${'a'}`;\n",
    '\nfetch(" https://example.com/api");\n',
    '\nfetch("\thttps://example.com/api");\n',
    '\nfetch("\\nhttps://example.com/api");\n',
    '\nfetch("https://example.com/api ");\n',
    "\nfetch(` https://example.com/api`);\n",
    '\nfetch("  WsS://example.com/api");\n',
    '\nfetch("\u0000https://example.com/api");\n',
    '\nfetch("\u001Fhttps://example.com/api");\n',
    '\nfetch("ht\\ntps://example.com/api");\n',
    '\nfetch("htt\\tps://example.com/api");\n',
    '\nfetch("https://example.com/api\\r\\n");\n',
    "\nfetch(`\\u0000https://example.com/api`);\n",
    "\nfetch(`ht\\ttps://example.com/api`);\n",
    '\nfetch("HT\\nTps://example.com/api");\n',
    '\nfetch("https:example.invalid/collect");\n',
    '\nfetch("https:/example.invalid/collect");\n',
    '\nfetch("/\\\\example.invalid/collect");\n',
    '\nfetch("\\\\\\\\example.invalid/collect");\n',
    '\nfetch("\\\\\/example.invalid/collect");\n',
    "\nfetch(`https:example.invalid/collect`);\n",
    "\nfetch(`\\\\\\\\example.invalid/collect`);\n",
    '\nconst img = document.createElement("img"); img.src = "https:example.invalid/x.png";\n',
    '\nconst img2 = document.createElement("img"); img2.src = "\\\\\\\\example.invalid/x.png";\n',
  ])(
    "rejects a distributed script that opens a third-party connection via %s",
    async (payload) => {
      const tamperedDist = await newTamperedDist();
      await cp(distRoot, tamperedDist, { recursive: true });
      await appendFile(join(tamperedDist, "scripts", "timeline.js"), payload);

      await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
        "external runtime dependency found in scripts/timeline.js",
      );
    },
  );

  it.each([
    "\nconst worker = new Worker('https://example.com/worker.js');\n",
    "\nconst worker = new Worker(`https://example.com/worker.js`);\n",
    "\nconst worker = new Worker('/worker.js');\n",
    "\nconst shared = new SharedWorker('/shared.js');\n",
    "\nconst worker = new window.Worker('/worker.js');\n",
    "\nconst shared = new window.SharedWorker('/shared.js');\n",
    "\nconst worker = new globalThis.Worker('/worker.js');\n",
    "\nconst shared = new globalThis.SharedWorker('/shared.js');\n",
    "\nconst worker = new self.Worker('/worker.js');\n",
    "\nconst shared = new self.SharedWorker('/shared.js');\n",
    '\nconst worker = new window["Worker"]("/worker.js");\n',
    '\nconst shared = new globalThis["SharedWorker"]("/shared.js");\n',
    "\nconst url = '/worker.js'; const worker = new Worker(url);\n",
  ])("rejects a distributed script that constructs a Worker via %s", async (payload) => {
    const tamperedDist = await newTamperedDist();
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(join(tamperedDist, "scripts", "timeline.js"), payload);

    await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
      "worker constructor found in scripts/timeline.js",
    );
  });

  it("rejects a seven-page candidate that lacks timeline or tag detail routes", async () => {
    // 构造“缺时间线与标签详情”的候选：从最终候选 dist 移除 /tags/* 与
    // /timeline/* 路由和文件，并同步改写 _publication.json。旧契约兼容
    // （默认验证）仍通过；七页面候选验收必须拒绝——不能只靠“元数据与
    // 文件集合彼此一致”放行。
    const prepare = async (removeRoutes: (route: string) => boolean): Promise<string> => {
      const tampered = await newTamperedDist();
      await cp(distRoot, tampered, { recursive: true });
      const metadataPath = join(tampered, "_publication.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      const kept = metadata.routes.filter((route: string) => !removeRoutes(route));
      if (kept.length === metadata.routes.length) {
        throw new Error("test setup failed: no routes removed");
      }
      metadata.routes = kept;
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      const htmlRoutes = await listSafeFiles(tampered, "distribution");
      for (const file of htmlRoutes) {
        if (
          file.endsWith(".html") &&
          removeRoutes(
            `/${file
              .replace(/\/index\.html$/, "")
              .split(sep)
              .join("/")}/`,
          )
        ) {
          await rm(join(tampered, file), { force: true });
        }
      }
      return tampered;
    };

    const withoutTimeline = await prepare(
      (route) => route === "/timeline/" || route.startsWith("/timeline/"),
    );
    const withoutTags = await prepare((route) => route.startsWith("/tags/"));

    // 缺时间线：领域首页链接到 /timeline/，内部链接完整性检查拒绝；
    // 七页面候选验收同样以路由完整性拒绝。任一防线都不得放行。
    await expect(verifyDistribution({ distRoot: withoutTimeline })).rejects.toThrow(
      /broken internal link/,
    );
    await expect(
      verifyDistribution({ distRoot: withoutTimeline, requireSevenPageRelease: true }),
    ).rejects.toThrow(/broken internal link|seven-page release candidate requires/);
    // 缺标签详情：主题总览链接到标签页，同样被拒绝；七页面候选验收以
    // “缺标签详情路由”显式拒绝。
    await expect(verifyDistribution({ distRoot: withoutTags })).rejects.toThrow(
      /broken internal link/,
    );
    await expect(
      verifyDistribution({ distRoot: withoutTags, requireSevenPageRelease: true }),
    ).rejects.toThrow(/broken internal link|seven-page release candidate requires/);
  });

  it(
    "accepts a complete candidate after swapping in different legitimate content identities",
    { timeout: 240_000 },
    async () => {
      // 换用另一组合法洞察/来源 ID（引用、文件摘要、manifest identity 同步
      // 由 fixture 生成器产出）：七页面候选验收必须无需任何测试改动即通过，
      // 证明门禁不依赖示例内容身份。
      const fixture = await writePublicationFixture({
        evidenceReadingContract: true,
        tagDetailContract: true,
        insightId: "insight-a1b2c3d4e5f60718293a4b5c",
        sourceId: "source-0f9e8d7c6b5a432112345678",
      });
      createdTempRoots.push(fixture.root);
      const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));
      await execFileAsync(
        process.execPath,
        [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
        { cwd: buildRoot },
      );
      await copyDeclaredAssets({
        inputRoot: fixture.root,
        distRoot: join(buildRoot, "dist"),
      });

      const metadata = await verifyDistribution({
        distRoot: join(buildRoot, "dist"),
        requireSevenPageRelease: true,
      });
      expect(metadata.routes).toContain("/timeline/");
      expect(metadata.routes.some((route) => route.startsWith("/tags/"))).toBe(true);
      expect(metadata.routes).toContain(`/insights/insight-a1b2c3d4e5f60718293a4b5c/`);
      expect(metadata.routes).toContain(`/sources/source-0f9e8d7c6b5a432112345678/`);
    },
  );

  it("verifies the final candidate dist as a complete seven-page release", async () => {
    // 最终候选 dist（npm run build 产物）必须通过七页面完整性验收。
    await expect(
      verifyDistribution({ distRoot: distRoot, requireSevenPageRelease: true }),
    ).resolves.toEqual(expect.objectContaining({ schemaVersion: 1 }));
  });

  it("still allows a JSON data-block script", async () => {
    // application/json 是声明式数据块（浏览器不执行），必须继续放行；
    // 这是脚本类型规则收紧后的合法正向用例。
    const tamperedDist = await newTamperedDist();
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(
      join(tamperedDist, ...defaultDomainOutputSegments, "index.html"),
      '<script type="application/json">{"probe":true}</script>',
    );

    await expect(verifyDistribution({ distRoot: tamperedDist })).resolves.toBeTruthy();
  });

  it("still allows same-origin relative URLs in distributed scripts", async () => {
    const tamperedDist = await newTamperedDist();
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(
      join(tamperedDist, "scripts", "timeline.js"),
      "\nfetch('/timeline/fragments/software-engineering/day/2026-08-30.json');\n" +
        "\nfetch(`/timeline/fragments/software-engineering/day/2026-08-30.json`);\n",
    );

    await expect(verifyDistribution({ distRoot: tamperedDist })).resolves.toEqual(
      expect.objectContaining({ schemaVersion: 1 }),
    );
  });

  it("rejects a release.json that drifts from the publication metadata", async () => {
    const tamperedDist = await newTamperedDist();
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
    const tamperedDist = await newTamperedDist();
    await cp(distRoot, tamperedDist, { recursive: true });
    await appendFile(join(tamperedDist, "maintenance", "index.html"), "<html></html>");

    await expect(verifyDistribution({ distRoot: tamperedDist })).rejects.toThrow(
      "distribution HTML routes differ from publication metadata",
    );
  });
});
