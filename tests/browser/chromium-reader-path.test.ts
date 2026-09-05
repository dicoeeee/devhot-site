import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  chromium,
  expect as pwExpect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import {
  buildReaderFixture,
  expectNoConsoleErrors,
  expectNoRootHorizontalOverflow,
  expectVisibleText,
  serveDistribution,
  viewports,
  type StaticServer,
} from "../support/browser-server";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser.close();
});

describe("Chromium full reader path", () => {
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

  let page: Page;

  beforeAll(async () => {
    const context = await browser.newContext({ viewport: viewports.desktop });
    page = await context.newPage();
  });

  afterAll(async () => {
    await page.close();
  });

  it(
    "covers the seven reader pages from the domain home without dead links",
    { timeout: 60_000 },
    async () => {
      const errors: string[] = [];
      expectNoConsoleErrors(page, errors);

      await page.goto(`${server.origin}/software-engineering/`);
      await expectVisibleText(page, "近期洞察");
      await pwExpect(page.locator("dialog[data-source-coverage-dialog]")).toBeHidden();
      await expectNoRootHorizontalOverflow(page);

      await page
        .getByRole("link", { name: /时间线/ })
        .first()
        .click();
      await page.waitForURL(/\/timeline\//);
      await expectVisibleText(page, "洞察时间线");
      await expectNoRootHorizontalOverflow(page);

      await page.getByRole("link", { name: "主题", exact: true }).first().click();
      await page.waitForURL(/\/topics\/$/);
      await expectVisibleText(page, "主题与标签");
      await expectNoRootHorizontalOverflow(page);

      await page
        .getByRole("link", { name: "可靠 Agent 交付", exact: false })
        .first()
        .click();
      await page.waitForURL(/\/topics\/reliable-agent-delivery\/$/);
      await expectVisibleText(page, "相关洞察");
      await expectNoRootHorizontalOverflow(page);

      await page
        .locator('a[href="/insights/insight-59498e27cf7aac1a9e4f9a76/"]')
        .first()
        .click();
      await page.waitForURL(/\/insights\/insight-59498e27cf7aac1a9e4f9a76\/$/);
      await expectVisibleText(page, "RESEARCH BRIEF");
      await expectNoRootHorizontalOverflow(page);

      await page
        .getByRole("link", { name: /阅读归档原文/ })
        .first()
        .click();
      await page.waitForURL(/\/sources\/source-59498e27cf7aac1a9e4f9a76\/$/);
      await expectVisibleText(page, "归档身份与完整性");
      await expectNoRootHorizontalOverflow(page);

      await page.goto(`${server.origin}/software-engineering/topics/`);
      await page.getByRole("link", { name: "reliability", exact: false }).first().click();
      await page.waitForURL(/\/tags\/problem\/reliability\/$/);
      await expectVisibleText(page, "受控标签");
      await expectNoRootHorizontalOverflow(page);

      expect(errors).toEqual([]);
    },
  );

  it(
    "keeps keyboard and touch interactions equivalent for the source coverage dialog",
    { timeout: 30_000 },
    async () => {
      const touchContext = await browser.newContext({
        viewport: viewports.mobile,
        hasTouch: true,
      });
      const touchPage = await touchContext.newPage();
      await touchPage.goto(`${server.origin}/software-engineering/`);
      const touchDialog = touchPage.locator("dialog[data-source-coverage-dialog]");
      const touchTrigger = touchPage.locator("[data-source-coverage-trigger]");
      await touchTrigger.tap();
      await pwExpect(touchDialog).toBeVisible();
      await touchPage.locator("[data-source-coverage-close]").tap();
      await pwExpect(touchDialog).toBeHidden();
      await touchPage.close();
      await touchContext.close();

      await page.goto(`${server.origin}/software-engineering/`);
      const dialog = page.locator("dialog[data-source-coverage-dialog]");
      const trigger = page.locator("[data-source-coverage-trigger]");

      await trigger.focus();
      await page.keyboard.press("Enter");
      await pwExpect(dialog).toBeVisible();
      expect(await dialog.evaluate((node) => (node as HTMLDialogElement).open)).toBe(
        true,
      );

      await page.keyboard.press("Escape");
      await pwExpect(dialog).toBeHidden();
      await pwExpect(trigger).toBeFocused();

      await trigger.click();
      await pwExpect(dialog).toBeVisible();
      await page.locator("[data-source-coverage-close]").click();
      await pwExpect(dialog).toBeHidden();
    },
  );

  it(
    "recovers timeline state through browser back navigation",
    { timeout: 30_000 },
    async () => {
      await page.goto(`${server.origin}/timeline/`);
      const more = page.locator("[data-timeline-more]");
      await pwExpect(more).toBeVisible();
      await more.click();
      await page.waitForURL(/before=/);
      const appendedGroups = await page.locator("[data-timeline-group]").count();

      await page.goBack();
      await page.waitForURL(/\/timeline\/\?domain=/);

      await page.goForward();
      await page.waitForURL(/before=/);
      await pwExpect(page.locator("[data-timeline-group]")).toHaveCount(appendedGroups);
    },
  );

  it(
    "keeps the loading failure recoverable with a retry action",
    { timeout: 30_000 },
    async () => {
      await page.goto(`${server.origin}/timeline/`);
      await page.route(/\/timeline\/fragments\//, (route) => route.abort());
      const more = page.locator("[data-timeline-more]");
      const beforeGroups = await page.locator("[data-timeline-group]").count();
      const currentUrl = page.url();

      await more.click();
      await pwExpect(page.locator("[data-timeline-error]")).toBeVisible();
      await pwExpect(more).toContainText("重试");
      await pwExpect(page.locator("[data-timeline-group]")).toHaveCount(beforeGroups);
      expect(page.url()).toBe(currentUrl);

      await page.unroute(/\/timeline\/fragments\//);
      await more.click();
      await pwExpect
        .poll(() => page.locator("[data-timeline-group]").count())
        .toBeGreaterThan(beforeGroups);
    },
  );

  it(
    "rejects an illegal timeline cursor with an explicit error and recovery link",
    { timeout: 30_000 },
    async () => {
      await page.goto(
        `${server.origin}/timeline/?domain=software-engineering&scale=day&before=2026-08-14`,
      );
      await pwExpect(page.locator("[data-timeline-error]")).toBeVisible();
      await pwExpect(page.locator("[data-timeline-error]")).toContainText(
        "时间线链接无效",
      );
      await pwExpect(page.locator("[data-timeline-latest]")).toBeVisible();
    },
  );
});

describe("Chromium responsive structure", () => {
  let server: StaticServer;
  let cleanup: () => Promise<void>;
  let context: BrowserContext;

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

  const openPage = async (viewport: { width: number; height: number }): Promise<Page> => {
    context = await browser.newContext({ viewport });
    return context.newPage();
  };

  it.each([
    ["mobile", viewports.mobile],
    ["tablet", viewports.tablet],
  ] as const)(
    "renders the insight brief as a single column below 1024px (%s)",
    { timeout: 60_000 },
    async (_name, viewport) => {
      const page = await openPage(viewport);
      const errors: string[] = [];
      expectNoConsoleErrors(page, errors);
      try {
        await page.goto(`${server.origin}/insights/insight-59498e27cf7aac1a9e4f9a76/`);
        const columns = await page
          .locator(".brief-layout")
          .evaluate((node) => getComputedStyle(node).gridTemplateColumns);
        expect(columns.split(" ").length).toBe(1);
        await expectVisibleText(page, "阅读信息");
        await expectVisibleText(page, "核心判断");
        await expectNoRootHorizontalOverflow(page);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
        await context.close();
      }
    },
  );

  it(
    "renders the desktop layout with a 280px fact column and 72ch prose",
    { timeout: 60_000 },
    async () => {
      const page = await openPage(viewports.desktop);
      const errors: string[] = [];
      expectNoConsoleErrors(page, errors);
      try {
        await page.goto(`${server.origin}/insights/insight-59498e27cf7aac1a9e4f9a76/`);
        const columns = await page
          .locator(".brief-layout")
          .evaluate((node) => getComputedStyle(node).gridTemplateColumns);
        expect(columns.split(" ")[0]).toBe("280px");

        const prose = await page.evaluate(() => {
          const node = document.querySelector(".brief-article");
          if (!node) return undefined;
          const style = getComputedStyle(node);
          return {
            widthPx: node.getBoundingClientRect().width,
            fontSize: parseFloat(style.fontSize),
          };
        });
        if (!prose) throw new Error("insight prose column is unavailable");
        expect(prose.widthPx / prose.fontSize).toBeLessThanOrEqual(76);

        const mainWidth = await page
          .locator("main")
          .evaluate((node) => node.getBoundingClientRect().width);
        expect(mainWidth).toBeLessThanOrEqual(1120);
        await expectNoRootHorizontalOverflow(page);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
        await context.close();
      }
    },
  );

  it(
    "keeps every reader page free of root horizontal overflow at three viewports",
    { timeout: 120_000 },
    async () => {
      const routes = [
        "/software-engineering/",
        "/model-research/",
        "/software-engineering/topics/",
        "/topics/reliable-agent-delivery/",
        "/tags/problem/reliability/",
        "/insights/insight-59498e27cf7aac1a9e4f9a76/",
        "/sources/source-59498e27cf7aac1a9e4f9a76/",
        "/timeline/",
      ];
      for (const viewport of Object.values(viewports)) {
        const page = await openPage(viewport);
        const errors: string[] = [];
        expectNoConsoleErrors(page, errors);
        try {
          for (const route of routes) {
            await page.goto(`${server.origin}${route}`);
            await expectNoRootHorizontalOverflow(page);
          }
          expect(errors).toEqual([]);
        } finally {
          await page.close();
          await context.close();
        }
      }
    },
  );
});
