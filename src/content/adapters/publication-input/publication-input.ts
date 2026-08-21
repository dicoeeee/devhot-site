export interface LegacyHomePublicationInput {
  readonly schemaVersion: 1;
  readonly domain: {
    readonly id: string;
    readonly name: string;
    readonly url: string;
  };
  readonly masthead: {
    readonly publication: "DEVHOT";
    readonly journal: "INSIGHT JOURNAL";
    readonly attribution: "公司持续集成管理委员会(CIMC)";
    readonly logoAssetPath: string;
  };
  readonly status: {
    readonly label: string;
    readonly updatedAt: string;
  };
  readonly intro: {
    readonly kicker: string;
    readonly headline: string;
    readonly summary: string;
  };
}

export type EditorialDomainId = "software-engineering" | "model-research";

export interface EditorialHomePublicationInput {
  readonly schemaVersion: 2;
  readonly defaultDomain: "software-engineering";
  readonly masthead: {
    readonly publication: "DEVHOT";
    readonly journal: "INSIGHT JOURNAL";
    readonly attribution: "公司持续集成管理委员会(CIMC)";
    readonly logoAssetPath: string;
  };
  readonly domains: readonly {
    readonly domain: {
      readonly id: EditorialDomainId;
      readonly name: "软件工程" | "模型研发";
      readonly url: "/software-engineering/" | "/model-research/";
    };
    readonly status: {
      readonly label: string;
      readonly updatedAt: string;
    };
    readonly weeklyFocus: {
      readonly weekStart: string;
      readonly weekEnd: string;
      readonly overview: string;
      readonly selectedCount: number;
      readonly sources: readonly {
        readonly name: string;
        readonly count: number;
      }[];
    };
    readonly recentInsights: readonly {
      readonly insightId: string;
      readonly status: "new" | "updated";
    }[];
  }[];
}

export type HomePublicationInput =
  LegacyHomePublicationInput | EditorialHomePublicationInput;

export interface VerifiedAsset {
  readonly path: string;
  readonly fullPath: string;
  readonly mediaType: "image/png";
  readonly sha256: string;
}

export interface ContentDatePublicationInput {
  readonly value: string;
  readonly basis: "published_at" | "first_collected_at";
}

export interface InsightPublicationInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceId: string;
  readonly domain: string;
  readonly domains?: readonly EditorialDomainId[];
  readonly title: string;
  readonly contentDate: ContentDatePublicationInput;
  readonly summary: string;
  readonly mechanism: {
    readonly status: "present" | "no_supported_content";
    readonly blocks: readonly {
      readonly kind: "text" | "source_image" | "technical_flow_mermaid";
      readonly text: string;
      readonly evidenceRefs: readonly {
        readonly evidenceId: string;
        readonly quote: string;
      }[];
    }[];
  };
  readonly keyInterpretation: string;
  readonly domainImplications: string;
  readonly tags: readonly { readonly type: string; readonly name: string }[];
  readonly citations: readonly {
    readonly sourceId: string;
    readonly evidenceId: string;
    readonly quote: string;
  }[];
  readonly sourceUrl: string;
  readonly officialUrl: string;
}

export interface SourceArchivePublicationInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly insightId: string;
  readonly source: { readonly id: string; readonly name: string };
  readonly title: string;
  readonly officialUrl: string;
  readonly contentDate: ContentDatePublicationInput;
  readonly body: {
    readonly format: "markdown" | "pages";
    readonly parts: readonly string[];
  };
  readonly images: readonly {
    readonly assetPath: string;
    readonly alt: string;
    readonly position: number;
  }[];
  readonly insightUrl: string;
}

export type TopicTagType = "domain" | "lifecycle" | "problem" | "method";

export interface TopicCatalogPublicationInput {
  readonly schemaVersion: 1;
  readonly matchingRulesVersion: "same-type-or-cross-type-and-v1";
  readonly topics: readonly {
    readonly id: string;
    readonly version: number;
    readonly name: string;
    readonly scope: string;
    readonly domains: readonly EditorialDomainId[];
    readonly tagFilters: readonly {
      readonly tagType: TopicTagType;
      readonly anyOf: readonly string[];
    }[];
    readonly currentMemberInsightIds: readonly string[];
    readonly latestConfirmedJudgment?: {
      readonly id: string;
      readonly sequence: number;
      readonly topicVersion: number;
      readonly matchingRulesVersion: "same-type-or-cross-type-and-v1";
      readonly statement: string;
      readonly boundary: string;
      readonly confirmedAt: string;
      readonly evidence: {
        readonly articleCount: number;
        readonly sourceCount: number;
        readonly dateFrom: string;
        readonly dateTo: string;
      };
    };
  }[];
}

export interface VerifiedPublicationInput {
  readonly root: string;
  readonly publicationId: string;
  readonly candidate: {
    readonly baselineSha: string;
    readonly inputIdentity: string;
  };
  readonly home: HomePublicationInput;
  readonly insights: readonly InsightPublicationInput[];
  readonly sources: readonly SourceArchivePublicationInput[];
  readonly topics?: TopicCatalogPublicationInput;
  readonly assets: ReadonlyMap<string, VerifiedAsset>;
}
