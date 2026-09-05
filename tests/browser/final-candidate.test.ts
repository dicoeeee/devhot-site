import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chromium } from "@playwright/test";

import { serveDistribution, expectVisibleText } from "../support/browser-server";

// #78 七页面发布候选验收：最终候选 dist/（npm run build 的产物，而非另行
// 构造的完整 fixture）必须包含全部七类页面并通过浏览器验收。
// 代表路由一律从当前候选的 _publication.json 路由清单推导，不写死任何
// 内容 ID——更换合法洞察/来源/主题身份后无需修改本文件即可通过。
// 旧契约兼容性（无时间线/标签的最小切片）由 publication-output 中的
// legacy 用例覆盖；本文件只验收最终候选。
const projectRoot = process.cwd();
const distRoot = join(projectRoot, "dist");

// 已确认的 CIMC 品牌标志：271×271 PNG 的固定 SHA-256。
// 正式候选必须携带该资产；测试 fixture 可用 1×1 占位图。
const CIMC_LOGO_SHA256 =
  "73bc08f1a558271ed021a4f51fcc4a07d2850deea7cb592282ae0f9d5a110c89";

interface Probe {
  readonly status: number;
  readonly body: string;
}

describe("final seven-page release candidate distribution", () => {
  let origin: string;
  let closeServer: () => Promise<void>;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let routes: readonly string[];

  // 按路由形状选择各类代表页面：领域首页、洞察、来源、主题总览、主题
  // 详情、标签详情、时间线。选择器只依赖路由语义，不依赖具体 ID。
  const representativeRoutes = (): {
    readonly route: string;
    readonly family: string;
    readonly text: string;
  }[] => {
    const pick = (predicate: (route: string) => boolean): string => {
      const found = routes.find(predicate);
      if (found === undefined) {
        throw new Error("no route matches the required page family");
      }
      return found;
    };
    return [
      {
        route: pick((route) => /^\/[^/]+\/$/.test(route)),
        family: "domain home",
        text: "近期洞察",
      },
      {
        route: pick((route) => route.startsWith("/insights/")),
        family: "insight detail",
        text: "阅读信息",
      },
      {
        route: pick((route) => route.startsWith("/sources/")),
        family: "source archive",
        text: "ARCHIVED SOURCE",
      },
      {
        route: pick((route) => route.endsWith("/topics/")),
        family: "topic overview",
        text: "主题与标签",
      },
      {
        route: pick((route) => /^\/topics\/[^/]+\/$/.test(route)),
        family: "topic detail",
        text: "相关洞察",
      },
      {
        route: pick((route) => /^\/tags\/[^/]+\/[^/]+\/$/.test(route)),
        family: "tag detail",
        text: "相关洞察",
      },
      {
        route: pick((route) => route === "/timeline/"),
        family: "timeline",
        text: "时间线",
      },
    ];
  };

  beforeAll(async () => {
    const metadata = JSON.parse(
      await readFile(join(distRoot, "_publication.json"), "utf8"),
    );
    routes = metadata.routes;
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
        for (const expected of representativeRoutes()) {
          const probeResult = await probe(expected.route);
          expect(probeResult.status, `${expected.family} ${expected.route}`).toBe(200);

          await page.goto(`${origin}${expected.route}`);
          await expectVisibleText(page, expected.text);
        }
      } finally {
        await page.close();
      }
    },
  );

  it("declares all seven page families in the publication metadata", () => {
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

  it("carries the confirmed CIMC logo byte-for-byte and renders it at full size", async () => {
    // 字节一致性：正式候选中的 CIMC 标志与已确认 SHA-256 完全一致。
    const logoPath = join(distRoot, "media", "sha256", `${CIMC_LOGO_SHA256}.png`);
    const logoBytes = await readFile(logoPath);
    expect(createHash("sha256").update(logoBytes).digest("hex")).toBe(CIMC_LOGO_SHA256);

    // 浏览器加载：alt="CIMC" 图片解码后的原始尺寸必须是 271×271，
    // 而不是占位图（1×1）或损坏资源（0）。
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/software-engineering/`);
      const naturalSize = await page.locator('img[alt="CIMC"]').evaluate((img) => ({
        width: (img as HTMLImageElement).naturalWidth,
        height: (img as HTMLImageElement).naturalHeight,
      }));
      expect(naturalSize).toEqual({ width: 271, height: 271 });
    } finally {
      await page.close();
    }
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
