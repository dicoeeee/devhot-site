import { describe, expect, it } from "vitest";

import { createPublicationInputRepository } from "../../src/content/adapters/publication-input/publication-input-repository";
import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
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

  it("preserves one shared insight identity across both domain homes", async () => {
    const fixture = await writePublicationFixture({
      insightDomainMembership: "shared",
    });
    const repository = await createSiteContentRepository(fixture.root);

    const homes = await repository.listHomes();
    const insights = await repository.listInsights();
    if (homes.some((home) => home.layout !== "editorial")) {
      throw new Error("expected editorial home pages");
    }

    expect(
      homes.map((home) =>
        home.layout === "editorial" ? home.recentInsights[0]?.id : undefined,
      ),
    ).toEqual([fixture.insightId, fixture.insightId]);
    expect(insights.filter((insight) => insight.id === fixture.insightId)).toHaveLength(
      1,
    );
    expect(insights.find((insight) => insight.id === fixture.insightId)).toMatchObject({
      domain: "software-engineering",
      domains: ["software-engineering", "model-research"],
    });
  });

  it("exposes the research brief facts, evidence-bound visuals, and separated related reading", async () => {
    const fixture = await writePublicationFixture({ evidenceReadingContract: true });
    const repository = await createSiteContentRepository(fixture.root);

    const insight = (await repository.listInsights()).find(
      (candidate) => candidate.id === fixture.insightId,
    );
    const source = (await repository.listSourceArchives()).find(
      (candidate) => candidate.id === fixture.sourceId,
    );

    expect(insight).toMatchObject({
      facts: {
        number: "59498E27",
        source: { id: "fixture-source", name: "Fixture Source" },
        version: "当前有效版本",
        topics: [{ id: fixture.topicId, name: "可靠 Agent 交付" }],
      },
      relatedReading: {
        deterministic: [
          {
            targetId: "insight-000000000000000000000002",
            targetKind: "insight",
            relationType: "same_object",
            relationLabel: "同一技术对象",
            direction: "undirected",
            basis: "共享同一经过验证的 repository identity。",
          },
        ],
        modelDerived: [
          {
            targetId: "insight-000000000000000000000002",
            targetKind: "insight",
            relationType: "depends_on",
            relationLabel: "依赖",
            direction: "outbound",
            explanation: "该实践依赖冻结评估输入形成可复核基线。",
          },
        ],
      },
    });
    expect(insight?.mechanism.blocks[1]).toMatchObject({
      kind: "source_image",
      visual: {
        alt: "冻结输入架构图",
        caption: "来源归档中的原始架构图",
      },
    });
    expect(source?.content.map((block) => block.kind)).toEqual(["text", "image", "text"]);
    expect(source?.archive).toEqual({
      status: "first_success_snapshot",
      archivedAt: "2026-08-11T08:05:00+00:00",
      contentSha256: "a".repeat(64),
      completeness: "complete",
    });
  });

  it("links related reading to a source archive when no current insight exists", async () => {
    const fixture = await writePublicationFixture({
      evidenceReadingContract: true,
      sourceFallbackRelation: true,
    });
    const repository = await createSiteContentRepository(fixture.root);
    const insight = (await repository.listInsights()).find(
      (candidate) => candidate.id === fixture.insightId,
    );

    expect(insight?.relatedReading.deterministic[0]).toMatchObject({
      targetId: fixture.fallbackSourceId,
      targetKind: "source",
      url: `/sources/${fixture.fallbackSourceId}/`,
      title: "Archived relation target 3",
    });
    expect(
      (await repository.listSourceArchives()).find(
        (source) => source.id === fixture.fallbackSourceId,
      ),
    ).not.toHaveProperty("insightUrl");
  });

  it("exposes topic-first domain indexes and the latest confirmed judgment", async () => {
    const fixture = await writePublicationFixture();
    const repository = await createSiteContentRepository(fixture.root);

    const overviews = await repository.listTopicOverviews();
    const pages = await repository.listTopicPages();

    expect(overviews.map((overview) => overview.domain.id)).toEqual([
      "software-engineering",
      "model-research",
    ]);
    expect(overviews[0]).toMatchObject({
      url: "/software-engineering/topics/",
      topics: [
        {
          id: fixture.topicId,
          url: `/topics/${fixture.topicId}/`,
          version: 3,
          memberCount: 2,
        },
      ],
      tags: [{ type: "problem", name: "reliability" }],
    });
    expect(pages[0]).toMatchObject({
      id: fixture.topicId,
      topicPage: 1,
      url: `/topics/${fixture.topicId}/`,
      currentMemberCount: 2,
      latestConfirmedJudgment: {
        statement: "可靠 Agent 交付正在从生成能力转向可验证的变更闭环。",
        topicVersion: 3,
        matchingRulesVersion: "same-type-or-cross-type-and-v1",
      },
    });
  });

  it("omits the entire judgment block when no confirmed judgment was published", async () => {
    const fixture = await writePublicationFixture({ topicJudgment: "none" });
    const repository = await createSiteContentRepository(fixture.root);

    const page = (await repository.listTopicPages()).find(
      (candidate) => candidate.id === fixture.topicId,
    );

    expect(page).toBeDefined();
    expect(page).not.toHaveProperty("latestConfirmedJudgment");
  });

  it("paginates current topic members by five with stable topic_page routes", async () => {
    const fixture = await writePublicationFixture();
    const input = await validatePublicationInput(fixture.root);
    if (!input.topics) throw new Error("expected topic fixture");
    const base = input.insights[0];
    if (!base) throw new Error("expected insight fixture");
    const additionalInsights = Array.from({ length: 4 }, (_, index) => ({
      ...base,
      id: `insight-${String(index + 3).padStart(24, "0")}`,
      sourceId: `source-${String(index + 3).padStart(24, "0")}`,
      title: `Topic member ${index + 3}`,
      contentDate: {
        ...base.contentDate,
        value: `2026-08-${String(16 - index).padStart(2, "0")}T08:00:00+00:00`,
      },
    }));
    const insights = [...input.insights, ...additionalInsights];
    const source = input.sources[0];
    if (!source) throw new Error("expected source fixture");
    const sources = [
      ...input.sources,
      ...additionalInsights.map((insight) => ({
        ...source,
        id: insight.sourceId,
        insightId: insight.id,
      })),
    ];
    const topic = input.topics.topics[0];
    if (!topic) throw new Error("expected topic definition");
    const repository = createPublicationInputRepository({
      ...input,
      insights,
      sources,
      topics: {
        ...input.topics,
        topics: [
          {
            ...topic,
            currentMemberInsightIds: insights.map((insight) => insight.id),
          },
        ],
      },
    });

    const pages = await repository.listTopicPages();

    expect(
      pages.map((page) => [page.topicPage, page.url, page.relatedInsights.length]),
    ).toEqual([
      [1, `/topics/${topic.id}/`, 5],
      [2, `/topics/${topic.id}/page/2/`, 1],
    ]);
  });

  it("keeps one stable page for a topic with no current members", async () => {
    const fixture = await writePublicationFixture({
      emptyTopic: true,
      topicJudgment: "none",
    });
    const repository = await createSiteContentRepository(fixture.root);

    const page = (await repository.listTopicPages()).find(
      (candidate) => candidate.id === fixture.topicId,
    );

    expect(page).toMatchObject({
      url: `/topics/${fixture.topicId}/`,
      topicPage: 1,
      pageCount: 1,
      currentMemberCount: 0,
      relatedInsights: [],
    });
  });

  it("builds governed tag detail pages with four-column topic data and stable tag_page routes", async () => {
    const fixture = await writePublicationFixture({ tagDetailContract: true });
    const input = await validatePublicationInput(fixture.root);
    if (!input.topics || input.topics.schemaVersion !== 2) {
      throw new Error("expected governed tag fixture");
    }
    const base = input.insights[0];
    const source = input.sources[0];
    if (!base || !source) throw new Error("expected tag insight fixture");
    const additionalInsights = Array.from({ length: 4 }, (_, index) => ({
      ...base,
      id: `insight-${String(index + 3).padStart(24, "0")}`,
      sourceId: `source-${String(index + 3).padStart(24, "0")}`,
      title: `Tag member ${index + 3}`,
      contentDate: {
        ...base.contentDate,
        value: `2026-08-${String(16 - index).padStart(2, "0")}T08:00:00+00:00`,
      },
    }));
    const insights = [...input.insights, ...additionalInsights];
    const sources = [
      ...input.sources,
      ...additionalInsights.map((insight) => ({
        ...source,
        id: insight.sourceId,
        insightId: insight.id,
      })),
    ];
    const reliability = input.topics.tags.find(
      (tag) => tag.type === "problem" && tag.name === "reliability",
    );
    if (!reliability) throw new Error("expected reliability tag");
    const repository = createPublicationInputRepository({
      ...input,
      insights,
      sources,
      topics: {
        ...input.topics,
        tags: input.topics.tags.map((tag) =>
          tag === reliability
            ? {
                ...tag,
                relatedInsightIds: insights.map((insight) => insight.id),
              }
            : tag,
        ),
      },
    });

    const pages = await repository.listTagPages();
    const overview = (await repository.listTopicOverviews())[0];
    const tagPages = pages.filter(
      (page) => page.type === "problem" && page.name === "reliability",
    );
    const emptyTagPage = pages.find(
      (page) => page.type === "method" && page.name === "observability",
    );

    expect(
      tagPages.map((page) => [page.tagPage, page.url, page.relatedInsights.length]),
    ).toEqual([
      [1, "/tags/problem/reliability/", 5],
      [2, "/tags/problem/reliability/page/2/", 1],
    ]);
    expect(tagPages[0]).toMatchObject({
      definition: "系统在预期条件下持续产生正确且可复核结果的能力。",
      aliases: ["Reliability"],
      domains: [
        { id: "software-engineering", name: "软件工程" },
        { id: "model-research", name: "模型研发" },
      ],
      relatedTopics: [
        {
          id: fixture.topicId,
          url: `/topics/${fixture.topicId}/`,
          name: "可靠 Agent 交付",
          memberCount: 2,
        },
      ],
    });
    expect(overview?.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "domain",
          name: "software-engineering",
          url: "/tags/domain/software-engineering/",
        }),
        expect.objectContaining({
          type: "problem",
          name: "reliability",
          url: "/tags/problem/reliability/",
        }),
      ]),
    );
    expect(emptyTagPage).toMatchObject({
      url: "/tags/method/observability/",
      tagPage: 1,
      pageCount: 1,
      relatedTopics: [],
      relatedInsightCount: 0,
      relatedInsights: [],
    });
  });

  it("fails fast when a verified topic member has no source identity", async () => {
    const fixture = await writePublicationFixture();
    const input = await validatePublicationInput(fixture.root);
    if (!input.topics) throw new Error("expected topic fixture");
    const base = input.insights[0];
    const topic = input.topics.topics[0];
    if (!base || !topic) throw new Error("expected topic member fixture");
    const missingSourceInsight = {
      ...base,
      id: "insight-000000000000000000000099",
      sourceId: "source-000000000000000000000099",
      title: "Missing source topic member",
    };
    const repository = createPublicationInputRepository({
      ...input,
      insights: [...input.insights, missingSourceInsight],
      topics: {
        ...input.topics,
        topics: [
          {
            ...topic,
            currentMemberInsightIds: [
              ...topic.currentMemberInsightIds,
              missingSourceInsight.id,
            ],
          },
        ],
      },
    });

    await expect(repository.listTopicPages()).rejects.toThrow(
      `verified topic source is unavailable: ${missingSourceInsight.id}`,
    );
  });
});
