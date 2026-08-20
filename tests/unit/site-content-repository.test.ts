import { describe, expect, it } from "vitest";

import { createSiteContentRepository } from "../../src/content/composition-root";
import { writePublicationFixture } from "../support/publication-fixture";

describe("SiteContentRepository", () => {
  it("maps the frozen editorial selection into ordered domain home pages", async () => {
    const fixture = await writePublicationFixture();
    const repository = await createSiteContentRepository(fixture.root);

    const homes = await repository.listHomes();
    const home = await repository.getHome();
    const modelHome = await repository.getHome("model-research");
    if (home.layout !== "editorial" || modelHome.layout !== "editorial") {
      throw new Error("expected editorial home pages");
    }

    expect(homes.map((candidate) => candidate.domain.id)).toEqual([
      "software-engineering",
      "model-research",
    ]);
    expect(home.domain).toEqual({
      id: "software-engineering",
      name: "软件工程",
      url: "/software-engineering/",
    });
    expect(home.isDefault).toBe(true);
    expect(home.brand.publication).toBe("DEVHOT");
    expect(home.brand.journal).toBe("INSIGHT JOURNAL");
    expect(home.brand.logoUrl).toMatch(/^\/media\/sha256\/[a-f0-9]{64}\.png$/);
    expect(home.weeklyFocus).toEqual({
      weekStart: "2026-08-10",
      weekEnd: "2026-08-16",
      overview: "冻结的软件工程周度概览。",
      selectedCount: 1,
      sources: [{ name: "Fixture Source", count: 1 }],
    });
    expect(home.recentInsights).toEqual([
      {
        sequence: 1,
        id: "insight-59498e27cf7aac1a9e4f9a76",
        url: "/insights/insight-59498e27cf7aac1a9e4f9a76/",
        contentDate: {
          value: "2026-08-11T08:00:00+00:00",
          basis: "published_at",
        },
        source: { id: "fixture-source", name: "Fixture Source" },
        status: { id: "new", label: "新发布" },
        title: "Reliable agent architecture 1",
        summary: "不可变输入让自动化结果可重放。",
      },
    ]);
    expect(modelHome.domain.id).toBe("model-research");
    expect(modelHome.weeklyFocus.overview).toBe("冻结的模型研发周度概览。");
    expect(modelHome.recentInsights[0]?.status.label).toBe("已更新");
  });

  it("preserves the legacy single-domain public port", async () => {
    const fixture = await writePublicationFixture({ legacyHomeContract: true });
    const repository = await createSiteContentRepository(fixture.root);

    const homes = await repository.listHomes();
    const home = await repository.getHome();

    expect(homes).toHaveLength(1);
    expect(home).toMatchObject({
      layout: "legacy",
      domain: { id: "software-engineering" },
      intro: { summary: "这是一份受控的最小发布输入。" },
    });
  });
});
