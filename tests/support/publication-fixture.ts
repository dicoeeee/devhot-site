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
  readonly evidenceReadingContract?: boolean;
  readonly omitRequiredArchiveEvidence?: boolean;
  readonly duplicateEditorialDomain?: "model-research" | "software-engineering";
  readonly emptyTopic?: boolean;
  readonly extraSourceReferencingInsight?: boolean;
  readonly invalidEditorialDomain?: boolean;
  readonly insightDomainMembership?:
    "duplicate" | "empty" | "missing-primary" | "overflow" | "shared" | "unknown";
  readonly invalidWeeklyRange?: boolean;
  readonly invalidMechanismContract?: "empty-blocks" | "empty-evidence";
  readonly mismatchedCitationEvidence?: boolean;
  readonly invalidRelationContract?: "direction" | "overflow" | "unknown-type";
  readonly legacyHomeContract?: boolean;
  readonly mermaidMechanismContract?: boolean;
  readonly missingWeeklyOverview?: boolean;
  readonly omitTopics?: boolean;
  readonly recentInsightSelection?:
    "complete" | "cross-domain" | "duplicate" | "empty" | "overflow";
  readonly staleWeeklyRange?: boolean;
  readonly sourceFallbackRelation?: boolean;
  readonly tagCatalogViolation?:
    | "dangling-domain"
    | "dangling-insight"
    | "dangling-topic"
    | "missing-reverse"
    | "unregistered-filter";
  readonly tagDetailContract?: boolean;
  readonly topicJudgment?: "confirmed" | "none";
  readonly topicJudgmentVersion?: number;
  readonly topicRuleViolation?: "duplicate-type" | "nested" | "not" | "member-mismatch";
  readonly unreferencedAsset?: boolean;
  readonly unreferencedJson?: boolean;
  readonly weeklySourceCounts?: "duplicate" | "mismatch";
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const writePublicationFixture = async (
  options: PublicationFixtureOptions = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "devhot-site-input-"));
  const logo = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const logoSha256 = sha256(logo);
  const logoPath = `assets/sha256/${logoSha256}.png`;
  const mermaidSvg =
    '<svg xmlns="http://www.w3.org/2000/svg"><text>freeze then validate</text></svg>';
  const mermaidSha256 = sha256(mermaidSvg);
  const mermaidPath = `assets/sha256/${mermaidSha256}.svg`;
  const insightId = "insight-59498e27cf7aac1a9e4f9a76";
  const sourceId = "source-59498e27cf7aac1a9e4f9a76";
  const modelInsightId = "insight-000000000000000000000002";
  const modelSourceId = "source-000000000000000000000002";
  const fallbackSourceId = "source-000000000000000000000003";
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
    schemaVersion: options.evidenceReadingContract ? 2 : 1,
    id: insightId,
    sourceId,
    domain: "software-engineering",
    ...(insightDomains !== undefined ? { domains: insightDomains } : {}),
    title: "Reliable agent architecture 1",
    contentDate: { value: "2026-08-11T08:00:00+00:00", basis: "published_at" },
    summary: "不可变输入让自动化结果可重放。",
    mechanism: {
      status: "present",
      blocks:
        options.invalidMechanismContract === "empty-blocks"
          ? []
          : [
              {
                kind: "text",
                text: "先冻结输入，再执行显式校验。",
                evidenceRefs:
                  options.invalidMechanismContract === "empty-evidence"
                    ? []
                    : [
                        {
                          evidenceId: "evidence-1",
                          quote: "Reliable agents use immutable inputs",
                        },
                      ],
              },
              ...(options.evidenceReadingContract
                ? [
                    {
                      kind: "source_image",
                      text: "冻结来源图展示输入先于校验进入流水线。",
                      assetPath: logoPath,
                      alt: "冻结输入架构图",
                      caption: "来源归档中的原始架构图",
                      evidenceRefs: [
                        {
                          evidenceId: "evidence-1",
                          quote: "Reliable agents use immutable inputs",
                        },
                      ],
                    },
                  ]
                : []),
              ...(options.mermaidMechanismContract
                ? [
                    {
                      kind: "technical_flow_mermaid",
                      text: "冻结的 Mermaid 技术流程图。",
                      assetPath: mermaidPath,
                      alt: "冻结后校验的技术流程",
                      caption: "由已冻结 Mermaid 输入确定性渲染",
                      evidenceRefs: [
                        {
                          evidenceId: "evidence-1",
                          quote: "Reliable agents use immutable inputs",
                        },
                      ],
                    },
                  ]
                : []),
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
        quote: options.mismatchedCitationEvidence
          ? "Different evidence"
          : "Reliable agents use immutable inputs",
      },
    ],
    ...(options.evidenceReadingContract
      ? {
          relations: {
            deterministic: Array.from(
              { length: options.invalidRelationContract === "overflow" ? 6 : 1 },
              () => ({
                target: options.sourceFallbackRelation
                  ? { kind: "source", id: fallbackSourceId }
                  : { kind: "insight", id: modelInsightId },
                relationType:
                  options.invalidRelationContract === "unknown-type"
                    ? "generated_similarity"
                    : "same_object",
                direction:
                  options.invalidRelationContract === "direction"
                    ? "outbound"
                    : "undirected",
                basis: "共享同一经过验证的 repository identity。",
              }),
            ),
            modelDerived: [
              {
                target: { kind: "insight", id: modelInsightId },
                relationType: "depends_on",
                direction: "outbound",
                explanation: "该实践依赖冻结评估输入形成可复核基线。",
              },
            ],
          },
        }
      : {}),
    sourceUrl: `/sources/${sourceId}/`,
    officialUrl: "https://example.com/reliable-agent-1",
  });
  const source = JSON.stringify({
    schemaVersion: options.evidenceReadingContract ? 2 : 1,
    id: sourceId,
    insightId,
    source: { id: "fixture-source", name: "Fixture Source" },
    title: "Reliable agent architecture 1",
    officialUrl: "https://example.com/reliable-agent-1",
    contentDate: { value: "2026-08-11T08:00:00+00:00", basis: "published_at" },
    ...(options.evidenceReadingContract
      ? {
          content: [
            { kind: "text", text: "Reliable agents use immutable inputs." },
            { kind: "image", assetPath: logoPath, alt: "Architecture" },
            { kind: "text", text: "Validation follows the frozen input." },
          ],
          ...(options.omitRequiredArchiveEvidence
            ? {}
            : {
                archive: {
                  status: "first_success_snapshot",
                  archivedAt: "2026-08-11T08:05:00+00:00",
                  contentSha256: "a".repeat(64),
                  completeness: "complete",
                },
              }),
        }
      : {
          body: { format: "markdown", parts: ["Reliable agents use immutable inputs."] },
          images: [{ assetPath: logoPath, alt: "Architecture", position: 1 }],
        }),
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
    mechanism: {
      status: "present",
      blocks: [
        {
          kind: "text",
          text: "先冻结模型评估输入，再执行显式校验。",
          evidenceRefs: [
            {
              evidenceId: "evidence-2",
              quote: "Reliable evaluations use frozen inputs",
            },
          ],
        },
      ],
    },
    ...(options.evidenceReadingContract
      ? {
          relations: { deterministic: [], modelDerived: [] },
        }
      : {}),
  });
  const modelSource = JSON.stringify({
    ...JSON.parse(source),
    id: modelSourceId,
    insightId: modelInsightId,
    source: { id: "model-fixture-source", name: "Model Fixture Source" },
    title: "Reliable model architecture 2",
    officialUrl: "https://example.com/reliable-model-2",
    insightUrl: `/insights/${modelInsightId}/`,
    ...(options.evidenceReadingContract
      ? {
          content: [{ kind: "text", text: "Reliable model evaluation source." }],
        }
      : {}),
  });
  const fallbackSource = JSON.stringify({
    schemaVersion: 2,
    id: fallbackSourceId,
    source: { id: "archive-only-source", name: "Archive-only Source" },
    title: "Archived relation target 3",
    officialUrl: "https://example.com/archive-only-3",
    contentDate: { value: "2026-08-10T08:00:00+00:00", basis: "published_at" },
    content: [{ kind: "text", text: "This related archive has no current insight." }],
    archive: {
      status: "first_success_snapshot",
      archivedAt: "2026-08-10T08:05:00+00:00",
      contentSha256: "b".repeat(64),
      completeness: "complete",
    },
  });
  const insightPath = `data/insights/${insightId}.json`;
  const sourcePath = `data/sources/${sourceId}.json`;
  const modelInsightPath = `data/insights/${modelInsightId}.json`;
  const modelSourcePath = `data/sources/${modelSourceId}.json`;
  const fallbackSourcePath = `data/sources/${fallbackSourceId}.json`;
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
          : [
              {
                tagType: "problem",
                anyOf: [
                  options.tagCatalogViolation === "unregistered-filter"
                    ? "unregistered-tag"
                    : "reliability",
                ],
              },
            ];
  const tagCatalog = options.tagDetailContract
    ? [
        {
          type: "domain",
          name: "software-engineering",
          definition: "软件系统的设计、开发、测试、交付与维护。",
          aliases: ["Software Engineering", "software engineering"],
          domains: [
            options.tagCatalogViolation === "dangling-domain"
              ? "operations"
              : "software-engineering",
          ],
          relatedTopicIds: [],
          relatedInsightIds: [insightId],
        },
        {
          type: "domain",
          name: "model-research",
          definition: "模型能力、训练、推理、评测及相关系统研究。",
          aliases: ["Model Research", "model research"],
          domains: ["model-research"],
          relatedTopicIds: [],
          relatedInsightIds: [modelInsightId],
        },
        {
          type: "problem",
          name: "reliability",
          definition: "系统在预期条件下持续产生正确且可复核结果的能力。",
          aliases: ["Reliability"],
          domains: ["software-engineering", "model-research"],
          relatedTopicIds:
            options.tagCatalogViolation === "missing-reverse"
              ? []
              : [
                  options.tagCatalogViolation === "dangling-topic"
                    ? "missing-topic"
                    : topicId,
                ],
          relatedInsightIds: [
            insightId,
            options.tagCatalogViolation === "dangling-insight"
              ? "insight-000000000000000000000099"
              : modelInsightId,
          ],
        },
        {
          type: "method",
          name: "evaluation",
          definition: "使用可复现任务、指标和样本测量模型或系统能力。",
          aliases: ["Evaluation", "Evals", "evals"],
          domains: ["software-engineering", "model-research"],
          relatedTopicIds: ["evaluation-boundaries"],
          relatedInsightIds: [modelInsightId],
        },
        {
          type: "method",
          name: "observability",
          definition: "利用遥测信号理解系统内部状态和行为的方法。",
          aliases: ["telemetry", "distributed tracing"],
          domains: ["software-engineering"],
          relatedTopicIds: [],
          relatedInsightIds: [],
        },
      ]
    : undefined;
  const topics = JSON.stringify({
    schemaVersion: options.tagDetailContract ? 2 : 1,
    matchingRulesVersion: "same-type-or-cross-type-and-v1",
    ...(tagCatalog ? { tags: tagCatalog } : {}),
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
  if (options.sourceFallbackRelation) {
    await writeFile(join(root, fallbackSourcePath), fallbackSource);
  }
  if (options.extraSourceReferencingInsight) {
    await writeFile(join(root, extraSourcePath), extraSource);
  }
  if (options.unreferencedJson) {
    await writeFile(join(root, unreferencedJsonPath), unreferencedJson);
  }
  await writeFile(join(root, logoPath), logo);
  if (options.mermaidMechanismContract) {
    await writeFile(join(root, mermaidPath), mermaidSvg);
  }
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
      ...(options.sourceFallbackRelation ? [fallbackSourcePath] : []),
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
    ...(options.sourceFallbackRelation
      ? [
          {
            path: fallbackSourcePath,
            mediaType: "application/json" as const,
            sha256: sha256(fallbackSource),
          },
        ]
      : []),
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
    ...(options.mermaidMechanismContract
      ? [
          {
            path: mermaidPath,
            mediaType: "image/svg+xml" as const,
            sha256: mermaidSha256,
          },
        ]
      : []),
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
      builderCompatibility: {
        min: options.tagDetailContract ? "0.4.0" : "0.2.0",
        maxExclusive: "1.0.0",
      },
      entrypoints,
      files,
    }),
  );

  return {
    root,
    logoPath,
    logoSha256,
    mermaidSha256,
    insightId,
    sourceId,
    fallbackSourceId,
    topicId,
    inputIdentity,
    publicationId,
  };
};
