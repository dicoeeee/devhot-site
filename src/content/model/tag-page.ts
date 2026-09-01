import type { HomePage } from "./home-page";

type EditorialDomainId = "software-engineering" | "model-research";
type TagType = "domain" | "lifecycle" | "problem" | "method";

export interface TagPage {
  readonly type: TagType;
  readonly name: string;
  readonly url: string;
  readonly tagPage: number;
  readonly pageCount: number;
  readonly definition: string;
  readonly aliases: readonly string[];
  readonly domains: readonly {
    readonly id: EditorialDomainId;
    readonly name: string;
    readonly url: string;
  }[];
  readonly brand: HomePage["brand"];
  readonly homeUrl: string;
  readonly topicsUrl: string;
  readonly relatedTopics: readonly {
    readonly id: string;
    readonly url: string;
    readonly name: string;
    readonly domains: readonly string[];
    readonly memberCount: number;
  }[];
  readonly relatedInsightCount: number;
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
