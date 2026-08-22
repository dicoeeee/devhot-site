interface HomePageBase {
  readonly topicsUrl?: string;
  readonly domain: {
    readonly id: string;
    readonly name: string;
    readonly url: string;
  };
  readonly isDefault: boolean;
  readonly availableDomains: readonly {
    readonly id: string;
    readonly name: string;
    readonly url: string;
  }[];
  readonly brand: {
    readonly publication: "DEVHOT";
    readonly journal: "INSIGHT JOURNAL";
    readonly attribution: "公司持续集成管理委员会(CIMC)";
    readonly logoUrl: string;
  };
  readonly status: {
    readonly label: string;
    readonly updatedAt: string;
  };
}

export interface LegacyHomePage extends HomePageBase {
  readonly layout: "legacy";
  readonly intro: {
    readonly kicker: string;
    readonly headline: string;
    readonly summary: string;
  };
}

export interface EditorialHomePage extends HomePageBase {
  readonly layout: "editorial";
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
    readonly sequence: number;
    readonly id: string;
    readonly url: string;
    readonly contentDate: {
      readonly value: string;
      readonly basis: "published_at" | "first_collected_at";
    };
    readonly source: {
      readonly id: string;
      readonly name: string;
    };
    readonly status: {
      readonly id: "new" | "updated";
      readonly label: "新发布" | "已更新";
    };
    readonly title: string;
    readonly summary: string;
  }[];
}

export type HomePage = LegacyHomePage | EditorialHomePage;
