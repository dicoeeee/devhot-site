import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { writePublicationFixture } from "../support/publication-fixture";
import { prepareStaticBuild } from "../support/static-build";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

const buildFixture = async (topicJudgment: "confirmed" | "none") => {
  const fixture = await writePublicationFixture({ topicJudgment });
  const buildRoot = await prepareStaticBuild(fixture.root);
  await execFileAsync(
    process.execPath,
    [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
    { cwd: buildRoot },
  );
  return { fixture, buildRoot };
};

describe("static topic pages", () => {
  it("builds a topic-first index and a vertically ordered topic detail", async () => {
    const { fixture, buildRoot } = await buildFixture("confirmed");
    const overview = await readFile(
      join(buildRoot, "dist", "software-engineering", "topics", "index.html"),
      "utf8",
    );
    const detail = await readFile(
      join(buildRoot, "dist", "topics", fixture.topicId, "index.html"),
      "utf8",
    );

    expect(overview).toContain("主题与标签");
    expect(overview).toContain(`href="/topics/${fixture.topicId}/"`);
    expect(overview).toContain(
      'href="/software-engineering/topics/#tag-problem-reliability"',
    );
    expect(overview.indexOf("当前主题")).toBeLessThan(overview.indexOf("标签索引"));

    const identity = detail.indexOf("可靠 Agent 交付");
    const judgment = detail.indexOf("主题判断");
    const related = detail.indexOf("相关洞察");
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(judgment).toBeGreaterThan(identity);
    expect(related).toBeGreaterThan(judgment);
    expect(detail).toContain("本次判断证据");
    expect(detail).toContain("当前主题共 2 篇");
    expect(detail).not.toContain("candidate");
    expect(detail).not.toContain("候选待确认");
  });

  it("omits judgment markup instead of rendering an empty-state placeholder", async () => {
    const { fixture, buildRoot } = await buildFixture("none");
    const detail = await readFile(
      join(buildRoot, "dist", "topics", fixture.topicId, "index.html"),
      "utf8",
    );

    expect(detail).not.toContain("主题判断");
    expect(detail).not.toContain("暂无判断");
    expect(detail).not.toContain("等待确认");
    expect(detail).toContain("相关洞察");
  });
});
