import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  calculatePublicationInputIdentity,
  publicationIdFor,
} from "../../src/content/adapters/publication-input/publication-identity";

interface PublicationFixtureOptions {
  readonly danglingLogoReference?: boolean;
  readonly extraSourceReferencingInsight?: boolean;
  readonly unreferencedAsset?: boolean;
  readonly unreferencedJson?: boolean;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const writePublicationFixture = async (
  options: PublicationFixtureOptions = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "devhot-site-input-"));
  const logo = "original-logo-bytes";
  const logoSha256 = sha256(logo);
  const logoPath = `assets/sha256/${logoSha256}.png`;
  const insightId = "insight-59498e27cf7aac1a9e4f9a76";
  const sourceId = "source-59498e27cf7aac1a9e4f9a76";
  const home = JSON.stringify({
    schemaVersion: 1,
    domain: {
      id: "software-engineering",
      name: "软件工程",
      url: "/software-engineering/",
    },
    masthead: {
      publication: "DEVHOT",
      journal: "INSIGHT JOURNAL",
      attribution: "公司持续集成管理委员会(CIMC)",
      logoAssetPath: options.danglingLogoReference
        ? `assets/sha256/${"0".repeat(64)}.png`
        : logoPath,
    },
    status: { label: "已验证发布输入", updatedAt: "2026-08-19" },
    intro: {
      kicker: "软件工程 · CURRENT DOMAIN",
      headline: "工程洞察，从证据到判断",
      summary: "这是一份受控的最小发布输入。",
    },
  });
  const insight = JSON.stringify({
    schemaVersion: 1,
    id: insightId,
    sourceId,
    domain: "software-engineering",
    title: "Reliable agent architecture 1",
    contentDate: { value: "2026-08-11T08:00:00+00:00", basis: "published_at" },
    summary: "不可变输入让自动化结果可重放。",
    mechanism: {
      status: "present",
      blocks: [
        {
          kind: "text",
          text: "先冻结输入，再执行显式校验。",
          evidenceRefs: [
            {
              evidenceId: "evidence-1",
              quote: "Reliable agents use immutable inputs",
            },
          ],
        },
      ],
    },
    keyInterpretation: "关键变化是把输出绑定到可审计输入。",
    domainImplications: "工程自动化需要可重放边界。",
    tags: [{ type: "domain", name: "software-engineering" }],
    citations: [
      {
        sourceId,
        evidenceId: "evidence-1",
        quote: "Reliable agents use immutable inputs",
      },
    ],
    sourceUrl: `/sources/${sourceId}/`,
    officialUrl: "https://example.com/reliable-agent-1",
  });
  const source = JSON.stringify({
    schemaVersion: 1,
    id: sourceId,
    insightId,
    source: { id: "fixture-source", name: "Fixture Source" },
    title: "Reliable agent architecture 1",
    officialUrl: "https://example.com/reliable-agent-1",
    contentDate: { value: "2026-08-11T08:00:00+00:00", basis: "published_at" },
    body: { format: "markdown", parts: ["Reliable agents use immutable inputs."] },
    images: [{ assetPath: logoPath, alt: "Architecture", position: 1 }],
    insightUrl: `/insights/${insightId}/`,
  });
  const insightPath = `data/insights/${insightId}.json`;
  const sourcePath = `data/sources/${sourceId}.json`;
  const extraSourceId = "source-000000000000000000000001";
  const extraSource = JSON.stringify({
    ...JSON.parse(source),
    id: extraSourceId,
  });
  const extraSourcePath = `data/sources/${extraSourceId}.json`;
  const unreferencedJson = JSON.stringify({ private: "draft" });
  const unreferencedJsonPath = "data/private-draft.json";

  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "assets", "sha256"), { recursive: true });
  await writeFile(join(root, "data", "home.json"), home);
  await mkdir(join(root, "data", "insights"), { recursive: true });
  await mkdir(join(root, "data", "sources"), { recursive: true });
  await writeFile(join(root, insightPath), insight);
  await writeFile(join(root, sourcePath), source);
  if (options.extraSourceReferencingInsight) {
    await writeFile(join(root, extraSourcePath), extraSource);
  }
  if (options.unreferencedJson) {
    await writeFile(join(root, unreferencedJsonPath), unreferencedJson);
  }
  await writeFile(join(root, logoPath), logo);
  const unreferenced = "unreferenced";
  const unreferencedSha256 = sha256(unreferenced);
  const unreferencedPath = `assets/sha256/${unreferencedSha256}.png`;
  if (options.unreferencedAsset) {
    await writeFile(join(root, unreferencedPath), unreferenced);
  }
  const entrypoints = {
    home: "data/home.json",
    insights: [insightPath],
    sources: [
      sourcePath,
      ...(options.extraSourceReferencingInsight ? [extraSourcePath] : []),
    ],
  };
  const files = [
    {
      path: "data/home.json",
      mediaType: "application/json" as const,
      sha256: sha256(home),
    },
    {
      path: insightPath,
      mediaType: "application/json" as const,
      sha256: sha256(insight),
    },
    {
      path: sourcePath,
      mediaType: "application/json" as const,
      sha256: sha256(source),
    },
    ...(options.extraSourceReferencingInsight
      ? [
          {
            path: extraSourcePath,
            mediaType: "application/json" as const,
            sha256: sha256(extraSource),
          },
        ]
      : []),
    ...(options.unreferencedJson
      ? [
          {
            path: unreferencedJsonPath,
            mediaType: "application/json" as const,
            sha256: sha256(unreferencedJson),
          },
        ]
      : []),
    {
      path: logoPath,
      mediaType: "image/png" as const,
      sha256: logoSha256,
    },
    ...(options.unreferencedAsset
      ? [
          {
            path: unreferencedPath,
            mediaType: "image/png" as const,
            sha256: unreferencedSha256,
          },
        ]
      : []),
  ];
  const baselineSha = "0".repeat(40);
  const inputIdentity = calculatePublicationInputIdentity({
    baselineSha,
    entrypoints,
    files,
  });
  const publicationId = publicationIdFor(inputIdentity);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      publicationId,
      candidate: { baselineSha, inputIdentity },
      builderCompatibility: { min: "0.2.0", maxExclusive: "1.0.0" },
      entrypoints,
      files,
    }),
  );

  return {
    root,
    logoPath,
    logoSha256,
    insightId,
    sourceId,
    inputIdentity,
    publicationId,
  };
};
