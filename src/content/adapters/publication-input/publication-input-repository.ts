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
): SiteContentRepository => ({
  async getHome(): Promise<HomePage> {
    const { home } = input;
    const logo = input.assets.get(home.masthead.logoAssetPath);
    if (!logo) {
      throw new Error("verified home logo is unavailable");
    }

    return {
      domain: { ...home.domain },
      brand: {
        publication: home.masthead.publication,
        journal: home.masthead.journal,
        attribution: home.masthead.attribution,
        logoUrl: mediaAssetRoute(logo.sha256),
      },
      status: { ...home.status },
      intro: { ...home.intro },
    };
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
});
