import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chromium } from "@playwright/test";

import { serveDistribution, expectVisibleText } from "../support/browser-server";

// #78 七页面发布候选验收：最终候选 dist/（npm run build 的产物，而非另行
// 构造的完整 fixture）必须包含全部七类页面并通过浏览器验收。
// 旧契约兼容性（无时间线/标签的最小切片）由 publication-output 中的
// legacy 用例覆盖；本文件只验收最终候选。
const projectRoot = process.cwd();
const distRoot = join(projectRoot, "dist");

interface Probe {
  readonly status: number;
  readonly body: string;
}

describe("final seven-page release candidate distribution", () => {
  let origin: string;
  let closeServer: () => Promise<void>;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;

  // 七类页面各取一个代表路由；与 _publication.json 的 17 条路由共同构成
  // “最终候选路由完整性 + 浏览器验收”两层断言。
  const sevenPages: readonly { readonly route: string; readonly text: string }[] = [
    { route: "/software-engineering/", text: "近期洞察" },
    { route: "/insights/insight-59498e27cf7aac1a9e4f9a76/", text: "阅读信息" },
    { route: "/sources/source-59498e27cf7aac1a9e4f9a76/", text: "ARCHIVED SOURCE" },
    { route: "/software-engineering/topics/", text: "主题与标签" },
    { route: "/topics/reliable-agent-delivery/", text: "相关洞察" },
    { route: "/tags/problem/reliability/", text: "相关洞察" },
    { route: "/timeline/", text: "时间线" },
  ];

  beforeAll(async () => {
    const server = await serveDistribution(distRoot);
    origin = server.origin;
    closeServer = server.close;
    browser = await chromium.launch();
  }, 240_000);

  afterAll(async () => {
    await browser.close();
    await closeServer();
  });

  const probe = async (route: string): Promise<Probe> => {
    const response = await fetch(`${origin}${route}`, { redirect: "manual" });
    return { status: response.status, body: await response.text() };
  };

  it(
    "serves every seven-page family with 200 and visible key content",
    { timeout: 120_000 },
    async () => {
      const page = await browser.newPage();
      try {
        for (const expected of sevenPages) {
          const probeResult = await probe(expected.route);
          expect(probeResult.status, expected.route).toBe(200);

          await page.goto(`${origin}${expected.route}`);
          await expectVisibleText(page, expected.text);
        }
      } finally {
        await page.close();
      }
    },
  );

  it("declares timeline and tag detail routes in the publication metadata", async () => {
    const metadata = JSON.parse(
      await readFile(join(distRoot, "_publication.json"), "utf8"),
    );
    const routes: readonly string[] = metadata.routes;
    expect(routes).toContain("/timeline/");
    expect(routes.some((route) => route.startsWith("/tags/"))).toBe(true);
    // 七类页面族齐全：领域首页、洞察、来源、主题总览、主题详情、标签、时间线。
    expect(routes.some((route) => /^\/[^/]+\/$/.test(route))).toBe(true);
    expect(routes.some((route) => route.startsWith("/insights/"))).toBe(true);
    expect(routes.some((route) => route.startsWith("/sources/"))).toBe(true);
    expect(routes.some((route) => route.endsWith("/topics/"))).toBe(true);
    expect(routes.some((route) => /^\/topics\/[^/]+\/$/.test(route))).toBe(true);
    expect(routes.some((route) => /^\/tags\/[^/]+\/[^/]+\/$/.test(route))).toBe(true);
  });

  it("serves timeline fragments for the timeline page", async () => {
    // 从最终候选 dist 的片段目录直接验证（时间线页面的运行时加载即来自
    // 这些 JSON 片段）。
    const fragmentsDir = join(distRoot, "timeline", "fragments");
    const domains = await readdir(fragmentsDir);
    expect(domains.length).toBeGreaterThan(0);
    for (const domain of domains) {
      const scales = await readdir(join(fragmentsDir, domain));
      for (const scale of scales) {
        const dates = await readdir(join(fragmentsDir, domain, scale));
        expect(dates.length).toBeGreaterThan(0);
        const fragment = await probe(
          `/timeline/fragments/${domain}/${scale}/${dates[0]}`,
        );
        expect(fragment.status).toBe(200);
        expect(JSON.parse(fragment.body).schemaVersion).toBe(1);
      }
    }
  });
});
