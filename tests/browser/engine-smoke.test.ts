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
        for (const route of routes) {
          await page.goto(`${server.origin}${route.path}`);
          await expectNoRootHorizontalOverflow(page);
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
        await context.close();
      }
    },
  );
});
