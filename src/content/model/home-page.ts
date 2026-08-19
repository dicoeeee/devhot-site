export interface HomePage {
  readonly domain: {
    readonly id: string;
    readonly name: string;
    readonly url: string;
  };
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
  readonly intro: {
    readonly kicker: string;
    readonly headline: string;
    readonly summary: string;
  };
}
