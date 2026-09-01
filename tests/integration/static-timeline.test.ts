import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareStaticBuild } from "../support/static-build";
import { writePublicationFixture } from "../support/publication-fixture";

const execFileAsync = promisify(execFile);
const astroCli = join(process.cwd(), "node_modules", "astro", "bin", "astro.mjs");

describe("static timeline", () => {
  it("builds intent-loaded fragments and a recoverable timeline shell", async () => {
    const fixture = await writePublicationFixture();
    const buildRoot = await prepareStaticBuild(fixture.root);

    await execFileAsync(process.execPath, [astroCli, "build"], { cwd: buildRoot });

    const html = await readFile(
      join(buildRoot, "dist", "timeline", "index.html"),
      "utf8",
    );
    const first = JSON.parse(
      await readFile(
        join(
          buildRoot,
          "dist",
          "timeline",
          "fragments",
          "software-engineering",
          "day",
          "2026-08-15.json",
        ),
        "utf8",
      ),
    );
    const interaction = await readFile(
      join(buildRoot, "dist", "scripts", "timeline.js"),
      "utf8",
    );

    expect(first).toMatchObject({
      identity: "software-engineering:day:2026-08-15",
      nextBefore: "2026-08-10",
      hasMore: true,
      groups: [{ kind: "day", date: "2026-08-19" }],
    });
    expect(html).toContain("洞察时间线");
    expect(html).toContain("data-timeline-stream");
    expect(html).toContain("data-timeline-more");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('src="/scripts/timeline.js"');
    expect(interaction).toContain("history.pushState");
    expect(interaction).toContain("popstate");
    expect(interaction).toContain("时间线链接无效");
    expect(interaction).toContain('more.textContent = "重试"');
    expect(interaction).not.toContain("IntersectionObserver");
    expect(interaction).not.toContain("requestIdleCallback");
    expect(interaction).not.toContain('rel="prefetch"');
  });
});
