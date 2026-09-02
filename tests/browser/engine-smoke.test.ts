import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { firefox, webkit, type Browser } from "@playwright/test";

import {
  buildReaderFixture,
  expectNoConsoleErrors,
  expectNoRootHorizontalOverflow,
  expectVisibleText,
  serveDistribution,
  viewports,
  type StaticServer,
} from "../support/browser-server";

const engines = [["Firefox", firefox] as const, ["WebKit", webkit] as const];

const routes = [
  { path: "/software-engineering/", text: "近期洞察" },
  { path: "/software-engineering/topics/", text: "主题与标签" },
  { path: "/topics/reliable-agent-delivery/", text: "相关洞察" },
  { path: "/tags/problem/reliability/", text: "受控标签" },
  { path: "/insights/insight-59498e27cf7aac1a9e4f9a76/", text: "RESEARCH BRIEF" },
  { path: "/sources/source-59498e27cf7aac1a9e4f9a76/", text: "归档身份与完整性" },
  { path: "/timeline/", text: "洞察时间线" },
];

const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  for (const [name, engine] of engines) {
    browsers[name] = await engine.launch();
  }
}, 480_000);

afterAll(async () => {
  await Promise.all(Object.values(browsers).map((browser) => browser.close()));
});

describe("Firefox and WebKit core smoke", () => {
  let server: StaticServer;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const build = await buildReaderFixture();
    server = await serveDistribution(build.distRoot);
    cleanup = async () => {
      await server.close();
      await build.cleanup();
    };
  }, 240_000);

  afterAll(async () => {
    await cleanup();
  });

  it.each(engines)(
    "%s renders the seven reader pages with navigation and content parity",
    { timeout: 240_000 },
    async (name) => {
      const browser = browsers[name]!;
      const context = await browser.newContext({ viewport: viewports.desktop });
      const page = await context.newPage();
      const errors: string[] = [];
      expectNoConsoleErrors(page, errors);
      try {
        for (const route of routes) {
          await page.goto(`${server.origin}${route.path}`);
          await expectVisibleText(page, route.text);
          await expectNoRootHorizontalOverflow(page);
        }

        await page.goto(`${server.origin}/software-engineering/`);
        await page
          .getByRole("link", { name: /时间线/ })
          .first()
          .click();
        await page.waitForURL(/\/timeline\//);
        const more = page.locator("[data-timeline-more]");
        await more.click();
        await page.waitForURL(/before=/);
        await expect
          .poll(() => page.locator("[data-timeline-group]").count())
          .toBeGreaterThan(1);
        await page.goBack();
        await page.waitForURL(/\/timeline\/\?domain=/);

        expect(errors).toEqual([]);
      } finally {
        await page.close();
        await context.close();
      }
    },
  );

  it.each(engines)(
    "%s keeps the mobile viewport free of root horizontal overflow",
    { timeout: 240_000 },
    async (name) => {
      const browser = browsers[name]!;
      const context = await browser.newContext({ viewport: viewports.mobile });
      const page = await context.newPage();
      const errors: string[] = [];
      expectNoConsoleErrors(page, errors);
      try {
        // 七类页面返回成功且关键内容可见，且与桌面语义一致。
        for (const route of routes) {
          const response = await page.goto(`${server.origin}${route.path}`);
          expect(response?.status()).toBe(200);
          await expectVisibleText(page, route.text);
          await expectNoRootHorizontalOverflow(page);
        }

        // 手机端布局状态：洞察简报为单列（< 1024px 语义）。
        await page.goto(`${server.origin}/insights/insight-59498e27cf7aac1a9e4f9a76/`);
        const columns = await page
          .locator(".brief-layout")
          .evaluate((node) => getComputedStyle(node).gridTemplateColumns);
        expect(columns.split(" ").length).toBe(1);
        await expectVisibleText(page, "阅读信息");
        await expectVisibleText(page, "核心判断");

        // 站内导航可用：从主题总览进入主题详情。
        await page.goto(`${server.origin}/software-engineering/topics/`);
        await page
          .getByRole("link", { name: "可靠 Agent 交付", exact: false })
          .first()
          .click();
        await page.waitForURL(/\/topics\/reliable-agent-delivery\/$/);
        await expectVisibleText(page, "相关洞察");

        // 时间线代表性交互：加载更多并返回。
        await page.goto(`${server.origin}/timeline/`);
        const more = page.locator("[data-timeline-more]");
        await more.click();
        await page.waitForURL(/before=/);
        await expect
          .poll(() => page.locator("[data-timeline-group]").count())
          .toBeGreaterThan(1);
        await page.goBack();
        await page.waitForURL(/\/timeline\/\?domain=/);

        expect(errors).toEqual([]);
      } finally {
        await page.close();
        await context.close();
      }
    },
  );
});
