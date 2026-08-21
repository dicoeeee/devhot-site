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
  readonly duplicateEditorialDomain?: "model-research" | "software-engineering";
  readonly emptyTopic?: boolean;
  readonly extraSourceReferencingInsight?: boolean;
  readonly invalidEditorialDomain?: boolean;
  readonly insightDomainMembership?:
    "duplicate" | "empty" | "missing-primary" | "overflow" | "shared" | "unknown";
  readonly invalidWeeklyRange?: boolean;
  readonly legacyHomeContract?: boolean;
  readonly missingWeeklyOverview?: boolean;
  readonly omitTopics?: boolean;
  readonly recentInsightSelection?:
    "complete" | "cross-domain" | "duplicate" | "empty" | "overflow";
  readonly staleWeeklyRange?: boolean;
  readonly topicJudgment?: "confirmed" | "none";
  readonly topicJudgmentVersion?: number;
  readonly topicRuleViolation?: "duplicate-type" | "nested" | "not" | "member-mismatch";
  readonly unreferencedAsset?: boolean;
  readonly unreferencedJson?: boolean;
  readonly weeklySourceCounts?: "duplicate" | "mismatch";
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
  const modelInsightId = "insight-000000000000000000000002";
  const modelSourceId = "source-000000000000000000000002";
  const insightDomains =
    options.insightDomainMembership === "empty"
      ? []
      : options.insightDomainMembership === "overflow"
        ? ["software-engineering", "model-research", "operations"]
        : options.insightDomainMembership === "shared"
          ? ["software-engineering", "model-research"]
          : options.insightDomainMembership === "missing-primary"
            ? ["model-research"]
            : options.insightDomainMembership === "unknown"
              ? ["software-engineering", "operations"]
              : options.insightDomainMembership === "duplicate"
                ? ["software-engineering", "software-engineering"]
                : undefined;
  const masthead = {
    publication: "DEVHOT",
    journal: "INSIGHT JOURNAL",
    attribution: "公司持续集成管理委员会(CIMC)",
    logoAssetPath: options.danglingLogoReference
      ? `assets/sha256/${"0".repeat(64)}.png`
      : logoPath,
  };
  const home = JSON.stringify(
    options.legacyHomeContract
      ? {
          schemaVersion: 1,
          domain: {
            id: options.invalidEditorialDomain ? "operations" : "software-engineering",
            name: options.invalidEditorialDomain ? "运维" : "软件工程",
            url: options.invalidEditorialDomain
              ? "/operations/"
              : "/software-engineering/",
          },
          masthead,
          status: { label: "已验证发布输入", updatedAt: "2026-08-19" },
          intro: {
            kicker: "软件工程 · CURRENT DOMAIN",
            headline: "工程洞察，从证据到判断",
            summary: "这是一份受控的最小发布输入。",
          },
        }
      : {
          schemaVersion: 2,
          defaultDomain: "software-engineering",
          masthead,
          domains: [
            {
              domain: {
                id:
                  options.duplicateEditorialDomain === "model-research"
                    ? "model-research"
                    : "software-engineering",
                name:
                  options.duplicateEditorialDomain === "model-research"
                    ? "模型研发"
                    : "软件工程",
                url:
                  options.duplicateEditorialDomain === "model-research"
                    ? "/model-research/"
                    : "/software-engineering/",
              },
              status: { label: "已验证发布输入", updatedAt: "2026-08-19" },
              weeklyFocus: {
                weekStart: options.invalidWeeklyRange
                  ? "2026-08-11"
                  : options.staleWeeklyRange
                    ? "2026-08-03"
                    : "2026-08-10",
                weekEnd: options.staleWeeklyRange ? "2026-08-09" : "2026-08-16",
                ...(options.missingWeeklyOverview
                  ? {}
                  : { overview: "冻结的软件工程周度概览。" }),
                selectedCount: options.weeklySourceCounts ? 2 : 1,
                sources:
                  options.weeklySourceCounts === "duplicate"
                    ? [
                        { name: "Fixture Source", count: 1 },
                        { name: "Fixture Source", count: 1 },
                      ]
                    : [{ name: "Fixture Source", count: 1 }],
              },
              recentInsights:
                options.recentInsightSelection === "empty"
                  ? []
                  : options.recentInsightSelection === "overflow"
                    ? Array.from({ length: 6 }, () => ({ insightId, status: "new" }))
                    : options.recentInsightSelection === "cross-domain"
                      ? [{ insightId: modelInsightId, status: "new" }]
                      : options.recentInsightSelection === "duplicate"
                        ? [
                            { insightId, status: "new" },
                            { insightId, status: "updated" },
                          ]
                        : [
                            {
                              insightId:
                                options.duplicateEditorialDomain === "model-research"
                                  ? modelInsightId
                                  : insightId,
                              status: "new",
                            },
                          ],
            },
            {
              domain: {
                id: options.invalidEditorialDomain
                  ? "operations"
                  : options.duplicateEditorialDomain === "software-engineering"
                    ? "software-engineering"
                    : "model-research",
                name:
                  options.duplicateEditorialDomain === "software-engineering"
                    ? "软件工程"
                    : "模型研发",
                url:
                  options.duplicateEditorialDomain === "software-engineering"
                    ? "/software-engineering/"
                    : "/model-research/",
              },
              status: { label: "已验证发布输入", updatedAt: "2026-08-19" },
              weeklyFocus: {
                weekStart: options.staleWeeklyRange ? "2026-08-03" : "2026-08-10",
                weekEnd: options.staleWeeklyRange ? "2026-08-09" : "2026-08-16",
                overview: "冻结的模型研发周度概览。",
                selectedCount: 1,
                sources: [{ name: "Model Fixture Source", count: 1 }],
              },
              recentInsights: [
                {
                  insightId:
                    options.insightDomainMembership === "shared"
                      ? insightId
                      : options.duplicateEditorialDomain === "software-engineering"
                        ? insightId
                        : modelInsightId,
                  status: "updated",
                },
              ],
            },
          ],
        },
  );
  const insight = JSON.stringify({
    schemaVersion: 1,
    id: insightId,
    sourceId,
    domain: "software-engineering",
    ...(insightDomains !== undefined ? { domains: insightDomains } : {}),
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
    tags: [
      { type: "domain", name: "software-engineering" },
      { type: "problem", name: "reliability" },
    ],
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
  const modelInsight = JSON.stringify({
    ...JSON.parse(insight),
    id: modelInsightId,
    sourceId: modelSourceId,
    domain: "model-research",
    title: "Reliable model architecture 2",
    summary: "冻结输入让模型评估可复核。",
    tags: [
      { type: "domain", name: "model-research" },
      { type: "problem", name: "reliability" },
      { type: "method", name: "evaluation" },
    ],
    sourceUrl: `/sources/${modelSourceId}/`,
    officialUrl: "https://example.com/reliable-model-2",
    citations: [
      {
        sourceId: modelSourceId,
        evidenceId: "evidence-2",
        quote: "Reliable evaluations use frozen inputs",
      },
    ],
  });
  const modelSource = JSON.stringify({
    ...JSON.parse(source),
    id: modelSourceId,
    insightId: modelInsightId,
    source: { id: "model-fixture-source", name: "Model Fixture Source" },
    title: "Reliable model architecture 2",
    officialUrl: "https://example.com/reliable-model-2",
    insightUrl: `/insights/${modelInsightId}/`,
  });
  const insightPath = `data/insights/${insightId}.json`;
  const sourcePath = `data/sources/${sourceId}.json`;
  const modelInsightPath = `data/insights/${modelInsightId}.json`;
  const modelSourcePath = `data/sources/${modelSourceId}.json`;
  const extraSourceId = "source-000000000000000000000001";
  const extraSource = JSON.stringify({
    ...JSON.parse(source),
    id: extraSourceId,
  });
  const extraSourcePath = `data/sources/${extraSourceId}.json`;
  const unreferencedJson = JSON.stringify({ private: "draft" });
  const unreferencedJsonPath = "data/private-draft.json";
  const topicId = "reliable-agent-delivery";
  const topicPath = "data/topics.json";
  const topicConditions = options.emptyTopic
    ? [{ tagType: "problem", anyOf: ["security"] }]
    : options.topicRuleViolation === "duplicate-type"
      ? [
          { tagType: "problem", anyOf: ["reliability"] },
          { tagType: "problem", anyOf: ["security"] },
        ]
      : options.topicRuleViolation === "nested"
        ? [
            {
              tagType: "problem",
              anyOf: ["reliability"],
              nested: { tagType: "method", anyOf: ["evaluation"] },
            },
          ]
        : options.topicRuleViolation === "not"
          ? [{ tagType: "problem", anyOf: ["reliability"], not: ["security"] }]
          : [{ tagType: "problem", anyOf: ["reliability"] }];
  const topics = JSON.stringify({
    schemaVersion: 1,
    matchingRulesVersion: "same-type-or-cross-type-and-v1",
    topics: [
      {
        id: topicId,
        version: 3,
        name: "可靠 Agent 交付",
        scope: "Agent 变更如何绑定冻结输入、独立验证与最终准入。",
        domains: ["software-engineering", "model-research"],
        tagFilters: topicConditions,
        currentMemberInsightIds: options.emptyTopic
          ? []
          : options.topicRuleViolation === "member-mismatch"
            ? [insightId]
            : [insightId, modelInsightId],
        ...(options.topicJudgment === "none"
          ? {}
          : {
              latestConfirmedJudgment: {
                id: "topic-judgment-reliable-agent-delivery-1",
                sequence: 1,
                topicVersion: options.topicJudgmentVersion ?? 3,
                matchingRulesVersion: "same-type-or-cross-type-and-v1",
                statement: "可靠 Agent 交付正在从生成能力转向可验证的变更闭环。",
                boundary: "证据来自具备独立检查和明确最终准入权的工程系统。",
                confirmedAt: "2026-08-18T09:30:00+08:00",
                evidence: {
                  articleCount: 4,
                  sourceCount: 2,
                  dateFrom: "2026-07-28",
                  dateTo: "2026-08-12",
                },
              },
            }),
      },
      {
        id: "evaluation-boundaries",
        version: 1,
        name: "评估边界",
        scope: "评估如何绑定可复核输入和明确适用范围。",
        domains: ["model-research"],
        tagFilters: [{ tagType: "method", anyOf: ["evaluation"] }],
        currentMemberInsightIds: [modelInsightId],
      },
    ],
  });

  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "assets", "sha256"), { recursive: true });
  await writeFile(join(root, "data", "home.json"), home);
  await mkdir(join(root, "data", "insights"), { recursive: true });
  await mkdir(join(root, "data", "sources"), { recursive: true });
  const includesTopics = !options.legacyHomeContract && !options.omitTopics;
  if (includesTopics) {
    await writeFile(join(root, topicPath), topics);
  }
  await writeFile(join(root, insightPath), insight);
  await writeFile(join(root, modelInsightPath), modelInsight);
  await writeFile(join(root, sourcePath), source);
  await writeFile(join(root, modelSourcePath), modelSource);
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
    insights: [insightPath, modelInsightPath],
    sources: [
      sourcePath,
      modelSourcePath,
      ...(options.extraSourceReferencingInsight ? [extraSourcePath] : []),
    ],
    ...(includesTopics ? { topics: topicPath } : {}),
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
    {
      path: modelInsightPath,
      mediaType: "application/json" as const,
      sha256: sha256(modelInsight),
    },
    {
      path: modelSourcePath,
      mediaType: "application/json" as const,
      sha256: sha256(modelSource),
    },
    ...(includesTopics
      ? [
          {
            path: topicPath,
            mediaType: "application/json" as const,
            sha256: sha256(topics),
          },
        ]
      : []),
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
    topicId,
    inputIdentity,
    publicationId,
  };
};
