export interface SourceArchivePage {
  readonly id: string;
  readonly url: string;
  readonly insightId?: string;
  readonly insightUrl?: string;
  readonly officialUrl: string;
  readonly source: { readonly id: string; readonly name: string };
  readonly title: string;
  readonly contentDate: {
    readonly value: string;
    readonly basis: "published_at" | "first_collected_at";
  };
  readonly body: {
    readonly format: "markdown" | "pages";
    readonly parts: readonly string[];
  };
  readonly images: readonly {
    readonly url: string;
    readonly alt: string;
    readonly position: number;
  }[];
  readonly content: readonly (
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly url: string; readonly alt: string }
  )[];
  readonly archive?: {
    readonly status: "first_success_snapshot";
    readonly archivedAt: string;
    readonly contentSha256: string;
    readonly completeness: "complete" | "partial";
  };
}
