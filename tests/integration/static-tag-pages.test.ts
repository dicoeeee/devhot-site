import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { writePublicationFixture } from "../support/publication-fixture";
import { prepareStaticBuild } from "../support/static-build";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

describe("static tag pages", () => {
  it("renders governed identity, a four-column topic matrix, stable links, and no search controls", async () => {
    const fixture = await writePublicationFixture({ tagDetailContract: true });
    const buildRoot = await prepareStaticBuild(fixture.root);
    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: buildRoot },
    );

    const overview = await readFile(
      join(buildRoot, "dist", "software-engineering", "topics", "index.html"),
      "utf8",
    );
    const detail = await readFile(
      join(buildRoot, "dist", "tags", "problem", "reliability", "index.html"),
      "utf8",
    );

    expect(overview).toContain('href="/tags/problem/reliability/"');
    expect(detail).toContain("系统在预期条件下持续产生正确且可复核结果的能力。");
    expect(detail).toContain("Reliability");
    expect(detail).toContain("软件工程");
    expect(detail).toContain("模型研发");
    expect(detail).toContain('class="tag-topic-matrix"');
    expect(detail).toContain(`href="/topics/${fixture.topicId}/"`);
    expect(detail).toContain(`href="/insights/${fixture.insightId}/"`);
    expect(detail).not.toContain("搜索");
    expect(detail).not.toContain("NOT");
    expect(detail).not.toContain("趋势");
  });
});
