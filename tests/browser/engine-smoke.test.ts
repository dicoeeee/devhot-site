import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { firefox, webkit, expect as pwExpect, type Browser } from "@playwright/test";

import {
  buildReaderFixture,
  serveDistribution,
  type StaticServer,
} from "../support/browser-server";

const engines = [["Firefox", firefox] as const, ["WebKit", webkit] as const];

const viewports = {
  mobile: { width: 375, height: 667 },
  desktop: { width: 1280, height: 800 },
} as const;

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
    async (name) => {
      const browser = browsers[name]!;
      const context = await browser.newContext({ viewport: viewports.desktop });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        for (const route of routes) {
          await page.goto(`${server.origin}${route.path}`);
          await pwExpect(
            page.getByText(route.text, { exact: false }).first(),
          ).toBeVisible();
          const overflow = await page.evaluate(
            () =>
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
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
        await pwExpect
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
    240_000,
  );

  it.each(engines)(
    "%s keeps the mobile viewport free of root horizontal overflow",
    async (name) => {
      const browser = browsers[name]!;
      const context = await browser.newContext({ viewport: viewports.mobile });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        for (const route of routes) {
          await page.goto(`${server.origin}${route.path}`);
          const overflow = await page.evaluate(
            () =>
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
        await context.close();
      }
    },
    240_000,
  );
});
