import type { HomePage } from "./home-page";

type EditorialDomainId = "software-engineering" | "model-research";

export type TimelineScale = "day" | "week";

export interface TimelineCard {
  readonly id: string;
  readonly url: string;
  readonly sourceName: string;
  readonly status: "new" | "updated";
  readonly statusLabel: "新发布" | "已更新";
  readonly title: string;
  readonly summary: string;
}

export type TimelineGroup =
  | {
      readonly kind: "day";
      readonly date: string;
      readonly insights: readonly TimelineCard[];
    }
  | {
      readonly kind: "week";
      readonly weekStart: string;
      readonly weekEnd: string;
      readonly insights: readonly TimelineCard[];
    };

export interface TimelineFragment {
  readonly schemaVersion: 1;
  readonly identity: string;
  readonly domainId: EditorialDomainId;
  readonly scale: TimelineScale;
  readonly before: string;
  readonly nextBefore?: string;
  readonly hasMore: boolean;
  readonly groups: readonly TimelineGroup[];
  readonly url: string;
}

export interface TimelinePage {
  readonly url: "/timeline/";
  readonly topicsUrl?: string;
  readonly domain: {
    readonly id: EditorialDomainId;
    readonly name: string;
    readonly homeUrl: string;
  };
  readonly availableDomains: readonly {
    readonly id: EditorialDomainId;
    readonly name: string;
    readonly url: string;
  }[];
  readonly brand: HomePage["brand"];
  readonly fragments: Readonly<{
    day: readonly TimelineFragment[];
    week: readonly TimelineFragment[];
  }>;
}
