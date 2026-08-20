import type { HomePage } from "../../model/home-page";
import {
  insightRoute,
  mediaAssetRoute,
  sourceArchiveRoute,
} from "../../model/site-routes";
import type { SiteContentRepository } from "../../ports/site-content-repository";
import type { VerifiedPublicationInput } from "./publication-input";

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
      return input.insights.map((insight) => ({
        id: insight.id,
        url: insightRoute(insight.id),
        sourceId: insight.sourceId,
        sourceUrl: insight.sourceUrl,
        officialUrl: insight.officialUrl,
        domain: insight.domain,
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
  };
};
