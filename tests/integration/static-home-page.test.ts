import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

import { writePublicationFixture } from "../support/publication-fixture";
import { prepareStaticBuild } from "../support/static-build";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const astroCli = join(projectRoot, "node_modules", "astro", "bin", "astro.mjs");

// 记录本文件创建的 buildRoot（devhot-site-page-*）与 fixture root
// （devhot-site-input-*）；teardown 精确回收，清理失败不得静默。
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
  if (failures.length > 0) {
    throw new AggregateError(failures, "static-home-page temp cleanup failed");
  }
});

describe("static editorial domain home", () => {
  it("builds the repository publication input without assuming its content", async () => {
    // 在隔离的临时构建目录中构建仓库 site-input，不再删除/改写项目 dist/
    // （项目 dist 是 final-candidate 验收的对象，测试之间不得互相破坏）。
    const buildRoot = await trackedBuildRoot(() =>
      prepareStaticBuild(join(projectRoot, "site-input")),
    );
    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot });

    const root = await readFile(join(buildRoot, "dist", "index.html"), "utf8");

    expect(root).toMatch(/<meta http-equiv="refresh" content="0;url=\/[^\"]+\/">/);
  });

  it("renders the complete editorial behavior from a controlled fixture", async () => {
    const fixture = await writePublicationFixture();
    createdTempRoots.push(fixture.root);
    const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));

    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot });

    const root = await readFile(join(buildRoot, "dist", "index.html"), "utf8");
    const software = await readFile(
      join(buildRoot, "dist", "software-engineering", "index.html"),
      "utf8",
    );
    const model = await readFile(
      join(buildRoot, "dist", "model-research", "index.html"),
      "utf8",
    );

    expect(root).toContain("url=/software-engineering/");
    expect(software).toContain("<title>DEVHOT · 软件工程</title>");
    expect(software).toContain('data-domain-status="software-engineering"');
    expect(software).toContain('href="/model-research/"');
    expect(software).toContain("冻结的软件工程周度概览。");
    expect(software.match(/data-recent-insight=/g)).toHaveLength(1);
    expect(software).toContain("01");
    expect(software).toContain('datetime="2026-08-11T08:00:00+00:00"');
    expect(software).toContain("Fixture Source");
    expect(software).toContain("新发布");
    expect(software).toContain("Reliable agent architecture 1");
    expect(software).toContain("不可变输入让自动化结果可重放。");
    expect(software).toContain('href="/insights/insight-59498e27cf7aac1a9e4f9a76/"');

    const timelineEntry = software.match(
      /<a\b[^>]*data-reading-entry="timeline"[^>]*>/,
    )?.[0];
    const topicsEntry = software.match(/<a\b[^>]*data-reading-entry="topics"[^>]*>/)?.[0];
    expect(timelineEntry).toContain(
      'href="/timeline/?domain=software-engineering&amp;scale=day"',
    );
    expect(timelineEntry).not.toContain('aria-disabled="true"');
    expect(topicsEntry).toContain('href="/software-engineering/topics/"');
    expect(topicsEntry).not.toContain('aria-disabled="true"');
    expect(software).toContain("时间线");
    expect(software).toContain("主题");
    expect(software).not.toMatch(/(?:日报|周报|报告|\/reports?\/)/);

    expect(model).toContain('data-domain-status="model-research"');
    expect(model).toContain('href="/software-engineering/"');
    expect(model).toContain("冻结的模型研发周度概览。");
    expect(model).toContain("已更新");
    expect(model).toContain("冻结输入让模型评估可复核。");
    expect(model).not.toContain("不可变输入让自动化结果可重放。");
  });

  it("derives the root redirect from a legacy extensible domain", async () => {
    const fixture = await writePublicationFixture({
      legacyHomeContract: true,
      invalidEditorialDomain: true,
    });
    createdTempRoots.push(fixture.root);
    const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));

    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot });

    const root = await readFile(join(buildRoot, "dist", "index.html"), "utf8");
    expect(root).toContain("url=/operations/");
  });

  it("keeps the topic entry disabled for a valid editorial input without topics", async () => {
    const fixture = await writePublicationFixture({ omitTopics: true });
    createdTempRoots.push(fixture.root);
    const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));

    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot });

    const software = await readFile(
      join(buildRoot, "dist", "software-engineering", "index.html"),
      "utf8",
    );
    const topicsEntry = software.match(/<a\b[^>]*data-reading-entry="topics"[^>]*>/)?.[0];
    expect(topicsEntry).toContain('aria-disabled="true"');
    expect(topicsEntry).not.toMatch(/\shref=/);
  });

  it("blocks page generation when the editorial home is incomplete", async () => {
    const fixture = await writePublicationFixture({ missingWeeklyOverview: true });
    createdTempRoots.push(fixture.root);
    const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));

    await expect(
      execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("invalid home page input"),
    });
  });

  it("executes equivalent source-coverage controls and restores focus", async () => {
    const fixture = await writePublicationFixture();
    createdTempRoots.push(fixture.root);
    const buildRoot = await trackedBuildRoot(() => prepareStaticBuild(fixture.root));

    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot });

    const html = await readFile(
      join(buildRoot, "dist", "software-engineering", "index.html"),
      "utf8",
    );
    const interaction = await readFile(
      join(buildRoot, "dist", "scripts", "source-coverage.js"),
      "utf8",
    );

    expect(html).toContain("data-source-coverage-trigger");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="查看 1 个覆盖来源"');
    expect(html).toContain('aria-controls="source-coverage-software-engineering"');
    expect(html).toContain(
      'data-source-coverage-dialog id="source-coverage-software-engineering"',
    );
    expect(html).toContain("Fixture Source");
    expect(html).toContain("1 篇");
    expect(html).toContain("data-source-coverage-close");
    expect(html).toContain('src="/scripts/source-coverage.js"');

    type Listener = (event: { target: unknown }) => void;
    class FakeElement {
      readonly attributes = new Map<string, string>();
      readonly listeners = new Map<string, Listener[]>();

      addEventListener(type: string, listener: Listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      dispatch(type: string, target: unknown = this) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ target });
        }
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }
    }

    class FakeButtonElement extends FakeElement {
      focusCount = 0;

      focus() {
        this.focusCount += 1;
      }
    }

    class FakeDialogElement extends FakeElement {
      open = false;

      showModal() {
        this.open = true;
      }

      close() {
        this.open = false;
        this.dispatch("close");
      }
    }

    const trigger = new FakeButtonElement();
    const closeButton = new FakeButtonElement();
    const dialog = new FakeDialogElement();
    const coverage = {
      querySelector(selector: string) {
        if (selector === "[data-source-coverage-trigger]") return trigger;
        if (selector === "[data-source-coverage-dialog]") return dialog;
        if (selector === "[data-source-coverage-close]") return closeButton;
        return null;
      },
    };
    const document = {
      querySelectorAll(selector: string) {
        return selector === "[data-source-coverage]" ? [coverage] : [];
      },
    };

    runInNewContext(interaction, {
      document,
      HTMLButtonElement: FakeButtonElement,
      HTMLDialogElement: FakeDialogElement,
    });

    for (const _activation of ["mouse", "keyboard", "touch"]) {
      trigger.dispatch("click");
      expect(dialog.open).toBe(true);
      expect(trigger.attributes.get("aria-expanded")).toBe("true");
      closeButton.dispatch("click");
      expect(dialog.open).toBe(false);
      expect(trigger.attributes.get("aria-expanded")).toBe("false");
    }
    trigger.dispatch("click");
    dialog.dispatch("click");
    expect(dialog.open).toBe(false);
    trigger.dispatch("click");
    dialog.close();
    expect(dialog.open).toBe(false);
    expect(trigger.focusCount).toBe(5);
  });
});
