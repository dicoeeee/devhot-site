import { createHash } from "node:crypto";

interface PublicationIdentityFields {
  readonly baselineSha: string;
  readonly entrypoints: {
    readonly home: string;
    readonly insights: readonly string[];
    readonly sources: readonly string[];
    readonly topics?: string;
  };
  readonly files: readonly {
    readonly path: string;
    readonly mediaType: "application/json" | "image/png" | "image/svg+xml";
    readonly sha256: string;
  }[];
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
};

export const calculatePublicationInputIdentity = ({
  baselineSha,
  entrypoints,
  files,
}: PublicationIdentityFields): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          schemaVersion: 2,
          baselineSha,
          entrypoints,
          files,
        }),
      ),
    )
    .digest("hex");

export const publicationIdFor = (inputIdentity: string): string =>
  `candidate-${inputIdentity.slice(0, 24)}`;
