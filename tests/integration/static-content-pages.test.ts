import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { writePublicationFixture } from "../support/publication-fixture";
import { prepareStaticBuild } from "../support/static-build";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

describe("static insight and source pages", () => {
  it("builds separately linked current insight and archived source pages", async () => {
    const fixture = await writePublicationFixture();
    const buildRoot = await prepareStaticBuild(fixture.root);

    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: buildRoot },
    );

    const insightId = "insight-59498e27cf7aac1a9e4f9a76";
    const sourceId = "source-59498e27cf7aac1a9e4f9a76";
    const insight = await readFile(
      join(buildRoot, "dist", "insights", insightId, "index.html"),
      "utf8",
    );
    const source = await readFile(
      join(buildRoot, "dist", "sources", sourceId, "index.html"),
      "utf8",
    );

    expect(insight).toContain("不可变输入让自动化结果可重放");
    expect(insight).toContain("Reliable agents use immutable inputs");
    expect(insight).toContain(`href="/sources/${sourceId}/"`);
    expect(insight).toContain('href="https://example.com/reliable-agent-1"');
    expect(source).toContain("发布于");
    expect(source).toContain("Reliable agents use immutable inputs.");
    expect(source).toContain(`href="/insights/${insightId}/"`);
    expect(source).toContain('src="/media/sha256/');
  });

  it("builds the research brief and source evidence reading order without placeholders", async () => {
    const fixture = await writePublicationFixture({ evidenceReadingContract: true });
    const buildRoot = await prepareStaticBuild(fixture.root);

    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: buildRoot },
    );

    const insight = await readFile(
      join(buildRoot, "dist", "insights", fixture.insightId, "index.html"),
      "utf8",
    );
    const source = await readFile(
      join(buildRoot, "dist", "sources", fixture.sourceId, "index.html"),
      "utf8",
    );

    expect(insight).toContain("RESEARCH BRIEF");
    expect(insight).toContain("阅读信息");
    expect(insight).toContain("确定性相关阅读");
    expect(insight).toContain("模型派生相关阅读");
    expect(insight).toContain("同一技术对象");
    expect(insight).toContain("依赖");
    expect(insight).toMatch(/class="brief-facts"[\s\S]*核心判断/);
    expect(insight).toContain('rel="noopener noreferrer"');
    expect(insight).not.toContain("机制图待补充");

    const sourceName = source.indexOf("ARCHIVED SOURCE · Fixture Source");
    const sourceDate = source.indexOf("发布于");
    const sourceTitle = source.indexOf("<h1>Reliable agent architecture 1</h1>");
    const firstText = source.indexOf("Reliable agents use immutable inputs.");
    const image = source.indexOf('alt="Architecture"');
    const finalText = source.indexOf("Validation follows the frozen input.");
    const evidence = source.indexOf("归档身份与完整性");
    expect(sourceName).toBeGreaterThan(-1);
    expect(sourceDate).toBeGreaterThan(sourceName);
    expect(sourceTitle).toBeGreaterThan(sourceDate);
    expect(firstText).toBeGreaterThan(sourceTitle);
    expect(image).toBeGreaterThan(firstText);
    expect(finalText).toBeGreaterThan(image);
    expect(evidence).toBeGreaterThan(finalText);
    expect(source).toContain("SHA-256");
    expect(source).toContain('rel="noopener noreferrer"');
  });
});
