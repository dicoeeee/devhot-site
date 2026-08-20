export type InsightDomainId = "software-engineering" | "model-research";

export interface InsightPage {
  readonly id: string;
  readonly url: string;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly officialUrl: string;
  readonly domain: string;
  readonly domains?: readonly InsightDomainId[];
  readonly title: string;
  readonly contentDate: {
    readonly value: string;
    readonly basis: "published_at" | "first_collected_at";
  };
  readonly summary: string;
  readonly mechanism: {
    readonly status: "present" | "no_supported_content";
    readonly blocks: readonly {
      readonly kind: "text" | "source_image" | "technical_flow_mermaid";
      readonly text: string;
    }[];
  };
  readonly keyInterpretation: string;
  readonly domainImplications: string;
  readonly tags: readonly { readonly type: string; readonly name: string }[];
  readonly citations: readonly {
    readonly evidenceId: string;
    readonly quote: string;
  }[];
}
