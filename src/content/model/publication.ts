export interface HomePublicationInput {
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

export interface VerifiedAsset {
  readonly path: string;
  readonly fullPath: string;
  readonly mediaType: "image/png";
  readonly sha256: string;
}

export interface VerifiedPublicationInput {
  readonly root: string;
  readonly publicationId: string;
  readonly home: HomePublicationInput;
  readonly assets: ReadonlyMap<string, VerifiedAsset>;
}
