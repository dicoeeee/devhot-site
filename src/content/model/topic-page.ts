import type { HomePage } from "./home-page";

type EditorialDomainId = "software-engineering" | "model-research";
type TopicTagType = "domain" | "lifecycle" | "problem" | "method";

export interface TopicTagLink {
  readonly type: TopicTagType;
  readonly name: string;
  readonly url: string;
  readonly anchorId: string;
}

export interface TopicOverviewPage {
  readonly url: string;
  readonly domain: {
    readonly id: EditorialDomainId;
    readonly name: string;
    readonly url: string;
  };
  readonly availableDomains: readonly {
    readonly id: string;
    readonly name: string;
    readonly url: string;
  }[];
  readonly brand: HomePage["brand"];
  readonly topics: readonly {
    readonly id: string;
    readonly url: string;
    readonly version: number;
    readonly name: string;
    readonly scope: string;
    readonly tags: readonly TopicTagLink[];
    readonly memberCount: number;
    readonly latestMemberDate: string;
  }[];
  readonly tags: readonly TopicTagLink[];
}

export interface TopicPage {
  readonly id: string;
  readonly url: string;
  readonly topicPage: number;
  readonly pageCount: number;
  readonly version: number;
  readonly name: string;
  readonly scope: string;
  readonly domains: readonly {
    readonly id: EditorialDomainId;
    readonly name: string;
    readonly url: string;
  }[];
  readonly brand: HomePage["brand"];
  readonly homeUrl: string;
  readonly topicsUrl: string;
  readonly tags: readonly TopicTagLink[];
  readonly currentMemberCount: number;
  readonly latestConfirmedJudgment?: {
    readonly id: string;
    readonly sequence: number;
    readonly topicVersion: number;
    readonly matchingRulesVersion: string;
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
  readonly relatedInsights: readonly {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly summary: string;
    readonly sourceName: string;
    readonly contentDate: {
      readonly value: string;
      readonly basis: "published_at" | "first_collected_at";
    };
  }[];
}
