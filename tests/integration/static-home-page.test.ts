import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

describe("static home page", () => {
  beforeEach(async () => {
    await rm(join(projectRoot, "dist"), { recursive: true, force: true });
  });

  it("builds the controlled domain fixture into a branded reading page", async () => {
    await execFileAsync(
      process.execPath,
      [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
      { cwd: projectRoot },
    );

    const html = await readFile(
      join(projectRoot, "dist", "software-engineering", "index.html"),
      "utf8",
    );

    expect(html).toContain("<title>DEVHOT · 软件工程</title>");
    expect(html).toContain("INSIGHT JOURNAL");
    expect(html).toContain("公司持续集成管理委员会(CIMC)");
    expect(html).toContain('data-domain-status="software-engineering"');
    expect(html).toContain('href="/software-engineering/"');
  });
});
