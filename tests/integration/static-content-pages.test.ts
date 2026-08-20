import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

describe("static insight and source pages", () => {
  beforeEach(async () => {
    await rm(join(projectRoot, "dist"), { recursive: true, force: true });
  });

  it("builds separately linked current insight and archived source pages", async () => {
    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: projectRoot },
    );

    const insightId = "insight-59498e27cf7aac1a9e4f9a76";
    const sourceId = "source-59498e27cf7aac1a9e4f9a76";
    const insight = await readFile(
      join(projectRoot, "dist", "insights", insightId, "index.html"),
      "utf8",
    );
    const source = await readFile(
      join(projectRoot, "dist", "sources", sourceId, "index.html"),
      "utf8",
    );

    expect(insight).toContain("不可变输入让自动化结果可重放");
    expect(insight).toContain("Reliable agents use immutable inputs");
    expect(insight).toContain(`href="/sources/${sourceId}/"`);
    expect(insight).toContain('href="https://example.com/reliable-agent-1"');
    expect(source).toContain("发布于");
    expect(source).toContain(
      "Reliable agents use immutable inputs and explicit validation.",
    );
    expect(source).toContain(`href="/insights/${insightId}/"`);
    expect(source).toContain('src="/media/sha256/');
  });
});
