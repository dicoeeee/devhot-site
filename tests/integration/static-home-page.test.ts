import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

import { writePublicationFixture } from "../support/publication-fixture";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const astroCli = join(projectRoot, "node_modules", "astro", "bin", "astro.mjs");

const prepareStaticBuild = async (inputRoot: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "devhot-site-page-"));
  await Promise.all(
    ["contracts", "public", "src"].map((path) =>
      cp(join(projectRoot, path), join(root, path), { recursive: true }),
    ),
  );
  await Promise.all(
    ["astro.config.mjs", "package.json", "tsconfig.json"].map((path) =>
      cp(join(projectRoot, path), join(root, path)),
    ),
  );
  await symlink(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  await symlink(inputRoot, join(root, "site-input"), "dir");
  return root;
};

describe("static editorial domain home", () => {
  beforeEach(async () => {
    await rm(join(projectRoot, "dist"), { recursive: true, force: true });
  });

  it("builds a canonical default and one complete page per editorial domain", async () => {
    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: projectRoot });

    const root = await readFile(join(projectRoot, "dist", "index.html"), "utf8");
    const software = await readFile(
      join(projectRoot, "dist", "software-engineering", "index.html"),
      "utf8",
    );
    const model = await readFile(
      join(projectRoot, "dist", "model-research", "index.html"),
      "utf8",
    );

    expect(root).toContain("url=/software-engineering/");
    expect(software).toContain("<title>DEVHOT · 软件工程</title>");
    expect(software).toContain('data-domain-status="software-engineering"');
    expect(software).toContain('href="/model-research/"');
    expect(software).toContain("上一个完整自然周的冻结软件工程概览。");
    expect(software.match(/data-recent-insight=/g)).toHaveLength(1);
    expect(software).toContain("01");
    expect(software).toContain('datetime="2026-08-11T08:00:00+00:00"');
    expect(software).toContain("Fixture Source");
    expect(software).toContain("新发布");
    expect(software).toContain("Reliable agent architecture 1");
    expect(software).toContain("不可变输入让自动化结果可重放。");
    expect(software).toContain('href="/insights/insight-59498e27cf7aac1a9e4f9a76/"');

    const readingEntries = [
      ...software.matchAll(/<a\b[^>]*data-reading-entry="(timeline|topics)"[^>]*>/g),
    ];
    expect(readingEntries.map((entry) => entry[1])).toEqual(["timeline", "topics"]);
    for (const [entry] of readingEntries) {
      expect(entry).toContain('aria-disabled="true"');
      expect(entry).not.toMatch(/\shref=/);
    }
    expect(software).toContain("时间线");
    expect(software).toContain("主题");
    expect(software).not.toMatch(/(?:日报|周报|报告|\/reports?\/)/);

    expect(model).toContain('data-domain-status="model-research"');
    expect(model).toContain('href="/software-engineering/"');
    expect(model).toContain("上一个完整自然周的冻结模型研发概览。");
    expect(model).toContain("已更新");
    expect(model).toContain("冻结输入让模型评估可复核。");
    expect(model).not.toContain("不可变输入让自动化结果可重放。");
  });

  it("derives the root redirect from a legacy extensible domain", async () => {
    const fixture = await writePublicationFixture({
      legacyHomeContract: true,
      invalidEditorialDomain: true,
    });
    const buildRoot = await prepareStaticBuild(fixture.root);

    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot });

    const root = await readFile(join(buildRoot, "dist", "index.html"), "utf8");
    expect(root).toContain("url=/operations/");
  });

  it("blocks page generation when the editorial home is incomplete", async () => {
    const fixture = await writePublicationFixture({ missingWeeklyOverview: true });
    const buildRoot = await prepareStaticBuild(fixture.root);

    await expect(
      execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("invalid home page input"),
    });
  });

  it("executes equivalent source-coverage controls and restores focus", async () => {
    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: projectRoot });

    const html = await readFile(
      join(projectRoot, "dist", "software-engineering", "index.html"),
      "utf8",
    );
    const interaction = await readFile(
      join(projectRoot, "dist", "scripts", "source-coverage.js"),
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
