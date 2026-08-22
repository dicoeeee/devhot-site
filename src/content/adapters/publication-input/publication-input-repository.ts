import type { HomePage } from "../../model/home-page";
import {
  insightRoute,
  mediaAssetRoute,
  sourceArchiveRoute,
  topicOverviewRoute,
  topicRoute,
  topicTagAnchor,
} from "../../model/site-routes";
import type { SiteContentRepository } from "../../ports/site-content-repository";
import type { EditorialDomainId, VerifiedPublicationInput } from "./publication-input";

export const createPublicationInputRepository = (
  input: VerifiedPublicationInput,
): SiteContentRepository => {
  const logo = input.assets.get(input.home.masthead.logoAssetPath);
  if (!logo) {
    throw new Error("verified home logo is unavailable");
  }
  const brand = {
    publication: input.home.masthead.publication,
    journal: input.home.masthead.journal,
    attribution: input.home.masthead.attribution,
    logoUrl: mediaAssetRoute(logo.sha256),
  } as const;
  const sourcesByInsightId = new Map(
    input.sources.map((source) => [source.insightId, source]),
  );

  const homes = (): readonly HomePage[] => {
    const home = input.home;
    if (home.schemaVersion === 1) {
      return [
        {
          layout: "legacy",
          ...(input.topics ? { topicsUrl: topicOverviewRoute(home.domain.id) } : {}),
          domain: { ...home.domain },
          isDefault: true,
          availableDomains: [{ ...home.domain }],
          brand,
          status: { ...home.status },
          intro: { ...home.intro },
        },
      ];
    }

    const availableDomains = home.domains.map((domainHome) => ({
      ...domainHome.domain,
    }));
    const insightsById = new Map(input.insights.map((insight) => [insight.id, insight]));
    return home.domains.map((domainHome) => ({
      layout: "editorial" as const,
      ...(input.topics ? { topicsUrl: topicOverviewRoute(domainHome.domain.id) } : {}),
      domain: { ...domainHome.domain },
      isDefault: domainHome.domain.id === home.defaultDomain,
      availableDomains,
      brand,
      status: { ...domainHome.status },
      weeklyFocus: {
        ...domainHome.weeklyFocus,
        sources: domainHome.weeklyFocus.sources.map((source) => ({ ...source })),
      },
      recentInsights: domainHome.recentInsights.map((recent, index) => {
        const insight = insightsById.get(recent.insightId);
        const source = insight ? sourcesByInsightId.get(insight.id) : undefined;
        if (!insight || !source) {
          throw new Error(`verified recent insight is unavailable: ${recent.insightId}`);
        }
        return {
          sequence: index + 1,
          id: insight.id,
          url: insightRoute(insight.id),
          contentDate: { ...insight.contentDate },
          source: { ...source.source },
          status: {
            id: recent.status,
            label: recent.status === "new" ? "新发布" : "已更新",
          },
          title: insight.title,
          summary: insight.summary,
        };
      }),
    }));
  };

  const insightPages = () =>
    input.insights.map((insight) => ({
      id: insight.id,
      url: insightRoute(insight.id),
      sourceId: insight.sourceId,
      sourceUrl: insight.sourceUrl,
      officialUrl: insight.officialUrl,
      domain: insight.domain,
      ...(insight.domains ? { domains: [...insight.domains] } : {}),
      title: insight.title,
      contentDate: { ...insight.contentDate },
      summary: insight.summary,
      mechanism: {
        status: insight.mechanism.status,
        blocks: insight.mechanism.blocks.map((block) => ({
          kind: block.kind,
          text: block.text,
        })),
      },
      keyInterpretation: insight.keyInterpretation,
      domainImplications: insight.domainImplications,
      tags: insight.tags.map((tag) => ({ ...tag })),
      citations: insight.citations.map((citation) => ({
        evidenceId: citation.evidenceId,
        quote: citation.quote,
      })),
    }));

  const topicTagLinks = (topic: NonNullable<typeof input.topics>["topics"][number]) => {
    const primaryDomain = topic.domains[0];
    if (!primaryDomain) throw new Error(`verified topic has no domain: ${topic.id}`);
    const overviewUrl = topicOverviewRoute(primaryDomain);
    return topic.tagFilters.flatMap((filter) =>
      filter.anyOf.map((name) => {
        const anchorId = topicTagAnchor(filter.tagType, name);
        return {
          type: filter.tagType,
          name,
          anchorId,
          url: `${overviewUrl}#${anchorId}`,
        };
      }),
    );
  };

  const sortedTopicMembers = (
    topic: NonNullable<typeof input.topics>["topics"][number],
  ) => {
    const members = new Set(topic.currentMemberInsightIds);
    return insightPages()
      .filter((insight) => members.has(insight.id))
      .sort(
        (left, right) =>
          right.contentDate.value.localeCompare(left.contentDate.value) ||
          left.id.localeCompare(right.id),
      );
  };

  const topicOverviews = () => {
    const topicCatalog = input.topics;
    if (!topicCatalog) return [];
    const homePages = homes();
    return homePages.flatMap((home) => {
      const domainId = home.domain.id;
      if (domainId !== "software-engineering" && domainId !== "model-research") {
        return [];
      }
      const editorialDomainId: EditorialDomainId = domainId;
      const topics = topicCatalog.topics.filter((topic) =>
        topic.domains.includes(editorialDomainId),
      );
      const tagByIdentity = new Map<string, ReturnType<typeof topicTagLinks>[number]>();
      for (const topic of topics) {
        for (const tag of topicTagLinks(topic)) {
          const anchorId = topicTagAnchor(tag.type, tag.name);
          tagByIdentity.set(`${tag.type}:${tag.name}`, {
            ...tag,
            anchorId,
            url: `${topicOverviewRoute(editorialDomainId)}#${anchorId}`,
          });
        }
      }
      return [
        {
          url: topicOverviewRoute(editorialDomainId),
          domain: {
            id: editorialDomainId,
            name: home.domain.name,
            url: home.domain.url,
          },
          availableDomains: homePages.map((candidate) => ({
            id: candidate.domain.id,
            name: candidate.domain.name,
            url: topicOverviewRoute(candidate.domain.id),
          })),
          brand,
          topics: topics.map((topic) => {
            const members = sortedTopicMembers(topic);
            return {
              id: topic.id,
              url: topicRoute(topic.id),
              version: topic.version,
              name: topic.name,
              scope: topic.scope,
              tags: topicTagLinks(topic).map((tag) => ({
                ...tag,
                url: `${topicOverviewRoute(editorialDomainId)}#${tag.anchorId}`,
              })),
              memberCount: members.length,
              latestMemberDate: members[0]?.contentDate.value ?? "",
            };
          }),
          tags: [...tagByIdentity.values()].sort(
            (left, right) =>
              left.type.localeCompare(right.type) || left.name.localeCompare(right.name),
          ),
        },
      ];
    });
  };

  const topicPages = () => {
    if (!input.topics) return [];
    const homePages = homes();
    const domainsById = new Map(homePages.map((home) => [home.domain.id, home.domain]));
    return input.topics.topics.flatMap((topic) => {
      const primaryDomain = topic.domains[0];
      if (!primaryDomain) throw new Error(`verified topic has no domain: ${topic.id}`);
      const related = sortedTopicMembers(topic).map((insight) => {
        const source = sourcesByInsightId.get(insight.id);
        if (!source) {
          throw new Error(`verified topic source is unavailable: ${insight.id}`);
        }
        return {
          id: insight.id,
          url: insight.url,
          title: insight.title,
          summary: insight.summary,
          sourceName: source.source.name,
          contentDate: { ...insight.contentDate },
        };
      });
      const pageCount = Math.max(1, Math.ceil(related.length / 5));
      const topicDomains = topic.domains.map((id) => {
        const domain = domainsById.get(id);
        if (!domain) throw new Error(`verified topic domain is unavailable: ${id}`);
        return { id, name: domain.name, url: domain.url };
      });
      return Array.from({ length: pageCount }, (_, index) => {
        const topicPage = index + 1;
        return {
          id: topic.id,
          url: topicRoute(topic.id, topicPage),
          topicPage,
          pageCount,
          version: topic.version,
          name: topic.name,
          scope: topic.scope,
          domains: topicDomains,
          brand,
          homeUrl: topicDomains[0]?.url ?? "/",
          topicsUrl: topicOverviewRoute(primaryDomain),
          tags: topicTagLinks(topic),
          currentMemberCount: related.length,
          ...(topic.latestConfirmedJudgment
            ? {
                latestConfirmedJudgment: {
                  ...topic.latestConfirmedJudgment,
                  evidence: { ...topic.latestConfirmedJudgment.evidence },
                },
              }
            : {}),
          relatedInsights: related.slice(index * 5, index * 5 + 5),
        };
      });
    });
  };

  return {
    async getHome(domainId?: string): Promise<HomePage> {
      const homePages = homes();
      const defaultHome = homePages.find((home) => home.isDefault);
      const home = domainId
        ? homePages.find((candidate) => candidate.domain.id === domainId)
        : defaultHome;
      if (!home) {
        throw new Error(`unknown home domain: ${domainId ?? "default"}`);
      }
      return home;
    },
    async listHomes(): Promise<readonly HomePage[]> {
      return homes();
    },
    async listInsights() {
      return insightPages();
    },
    async listSourceArchives() {
      return input.sources.map((source) => ({
        id: source.id,
        url: sourceArchiveRoute(source.id),
        insightId: source.insightId,
        insightUrl: source.insightUrl,
        officialUrl: source.officialUrl,
        source: { ...source.source },
        title: source.title,
        contentDate: { ...source.contentDate },
        body: { format: source.body.format, parts: [...source.body.parts] },
        images: source.images.map((image) => {
          const asset = input.assets.get(image.assetPath);
          if (!asset)
            throw new Error(`verified source image is unavailable: ${image.assetPath}`);
          return {
            url: mediaAssetRoute(asset.sha256),
            alt: image.alt,
            position: image.position,
          };
        }),
      }));
    },
    async listTopicOverviews() {
      return topicOverviews();
    },
    async listTopicPages() {
      return topicPages();
    },
  };
};
