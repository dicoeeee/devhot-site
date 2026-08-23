import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

import Ajv, { type ErrorObject, type JSONSchemaType, type ValidateFunction } from "ajv";

import { listSafeFiles } from "../../../infrastructure/list-safe-files";
import { insightRoute, sourceArchiveRoute } from "../../model/site-routes";
import {
  calculatePublicationInputIdentity,
  publicationIdFor,
} from "./publication-identity";
import type {
  HomePublicationInput,
  InsightPublicationInput,
  SourceArchivePublicationInput,
  TopicCatalogPublicationInput,
  VerifiedAsset,
  VerifiedPublicationInput,
} from "./publication-input";

interface ManifestFile {
  readonly path: string;
  readonly mediaType: "application/json" | "image/png" | "image/svg+xml";
  readonly sha256: string;
}

interface PublicationManifest {
  readonly schemaVersion: 2;
  readonly publicationId: string;
  readonly candidate: {
    readonly baselineSha: string;
    readonly inputIdentity: string;
  };
  readonly builderCompatibility: {
    readonly min: string;
    readonly maxExclusive: string;
  };
  readonly entrypoints: {
    readonly home: string;
    readonly insights: readonly string[];
    readonly sources: readonly string[];
    readonly topics?: string;
  };
  readonly files: readonly ManifestFile[];
}

const BUILDER_VERSION = "0.3.0";
const contractsRoot = join(process.cwd(), "contracts");

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const loadSchema = async <T>(name: string): Promise<JSONSchemaType<T>> =>
  (await readJson(join(contractsRoot, name))) as JSONSchemaType<T>;

const formatErrors = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");

const compareVersion = (left: string, right: string): number => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const assertSafePath = (path: string): void => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`manifest contains unsafe path: ${path}`);
  }
};

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const declaredJson = (
  manifest: PublicationManifest,
  path: string,
  label: string,
): ManifestFile => {
  assertSafePath(path);
  const file = manifest.files.find((candidate) => candidate.path === path);
  if (file?.mediaType !== "application/json") {
    throw new Error(`${label} must reference a declared JSON file: ${path}`);
  }
  return file;
};

const validatedJson = async <T>(
  root: string,
  path: string,
  validate: ValidateFunction<T>,
  label: string,
): Promise<T> => {
  const value = await readJson(join(root, path));
  if (!validate(value)) {
    throw new Error(`invalid ${label}: ${formatErrors(validate.errors)}`);
  }
  return value;
};

const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new Error(`publication contains duplicate ${label}`);
  }
};

const matchesTopic = (
  insight: InsightPublicationInput,
  topic: TopicCatalogPublicationInput["topics"][number],
): boolean => {
  const tags = new Set(insight.tags.map((tag) => `${tag.type}:${tag.name}`));
  return topic.tagFilters.every((filter) =>
    filter.anyOf.some((name) => tags.has(`${filter.tagType}:${name}`)),
  );
};

export const validatePublicationInput = async (
  inputRoot: string,
): Promise<VerifiedPublicationInput> => {
  const root = resolve(inputRoot);
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  ajv.addFormat("date-time", (value: string) => Number.isFinite(Date.parse(value)));
  const validateManifest = ajv.compile<PublicationManifest>(
    await loadSchema<PublicationManifest>("publication-manifest.schema.json"),
  );
  const validateHome = ajv.compile<HomePublicationInput>(
    await loadSchema<HomePublicationInput>("home-page.schema.json"),
  );
  const validateInsight = ajv.compile<InsightPublicationInput>(
    await loadSchema<InsightPublicationInput>("insight.schema.json"),
  );
  const validateSource = ajv.compile<SourceArchivePublicationInput>(
    await loadSchema<SourceArchivePublicationInput>("source-archive.schema.json"),
  );
  const validateTopics = ajv.compile<TopicCatalogPublicationInput>(
    await loadSchema<TopicCatalogPublicationInput>("topic-catalog.schema.json"),
  );

  const rawManifest = await readJson(join(root, "manifest.json"));
  if (!validateManifest(rawManifest)) {
    throw new Error(
      `invalid publication manifest: ${formatErrors(validateManifest.errors)}`,
    );
  }
  const manifest = rawManifest;

  if (
    compareVersion(BUILDER_VERSION, manifest.builderCompatibility.min) < 0 ||
    compareVersion(BUILDER_VERSION, manifest.builderCompatibility.maxExclusive) >= 0
  ) {
    throw new Error(`publication is incompatible with builder ${BUILDER_VERSION}`);
  }
  const calculatedInputIdentity = calculatePublicationInputIdentity({
    baselineSha: manifest.candidate.baselineSha,
    entrypoints: manifest.entrypoints,
    files: manifest.files,
  });
  if (manifest.candidate.inputIdentity !== calculatedInputIdentity) {
    throw new Error("candidate input identity does not match manifest content");
  }
  if (manifest.publicationId !== publicationIdFor(calculatedInputIdentity)) {
    throw new Error("publicationId must be derived from candidate inputIdentity");
  }

  const declaredPaths = new Set<string>();
  for (const file of manifest.files) {
    assertSafePath(file.path);
    if (declaredPaths.has(file.path)) {
      throw new Error(`manifest declares duplicate file: ${file.path}`);
    }
    declaredPaths.add(file.path);
  }

  const actualPaths = await listSafeFiles(root, "publication input");
  const expectedPaths = ["manifest.json", ...declaredPaths].sort();
  if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error(
      `publication file set differs from manifest; expected ${expectedPaths.join(", ")}; found ${actualPaths.join(", ")}`,
    );
  }

  const assets = new Map<string, VerifiedAsset>();
  for (const file of manifest.files) {
    const fullPath = join(root, file.path);
    const metadata = await stat(fullPath);
    if ((metadata.mode & 0o111) !== 0) {
      throw new Error(`publication input file must not be executable: ${file.path}`);
    }
    const actualHash = sha256(await readFile(fullPath));
    if (actualHash !== file.sha256) {
      throw new Error(`sha256 mismatch for ${file.path}`);
    }
    if (file.path.startsWith("assets/")) {
      const extension = file.mediaType === "image/svg+xml" ? "svg" : "png";
      if (
        (file.mediaType !== "image/png" && file.mediaType !== "image/svg+xml") ||
        file.path !== `assets/sha256/${file.sha256}.${extension}`
      ) {
        throw new Error(`asset path is not content addressed: ${file.path}`);
      }
      assets.set(file.path, {
        path: file.path,
        fullPath,
        mediaType: file.mediaType,
        sha256: file.sha256,
      });
    }
  }

  declaredJson(manifest, manifest.entrypoints.home, "home entrypoint");
  for (const path of manifest.entrypoints.insights) {
    declaredJson(manifest, path, "insight entrypoint");
  }
  for (const path of manifest.entrypoints.sources) {
    declaredJson(manifest, path, "source entrypoint");
  }
  if (manifest.entrypoints.topics) {
    declaredJson(manifest, manifest.entrypoints.topics, "topic entrypoint");
  }
  const typedJsonPaths = [
    manifest.entrypoints.home,
    ...manifest.entrypoints.insights,
    ...manifest.entrypoints.sources,
    ...(manifest.entrypoints.topics ? [manifest.entrypoints.topics] : []),
  ];
  assertUnique(typedJsonPaths, "typed JSON entrypoint");
  const declaredJsonPaths = manifest.files
    .filter((file) => file.mediaType === "application/json")
    .map((file) => file.path)
    .sort();
  if (declaredJsonPaths.join("\n") !== [...typedJsonPaths].sort().join("\n")) {
    throw new Error("manifest JSON files must exactly match typed entrypoints");
  }

  const home = await validatedJson(
    root,
    manifest.entrypoints.home,
    validateHome,
    "home page input",
  );
  const insights = await Promise.all(
    manifest.entrypoints.insights.map((path) =>
      validatedJson(root, path, validateInsight, `insight input ${path}`),
    ),
  );
  const sources = await Promise.all(
    manifest.entrypoints.sources.map((path) =>
      validatedJson(root, path, validateSource, `source input ${path}`),
    ),
  );
  const topics = manifest.entrypoints.topics
    ? await validatedJson(
        root,
        manifest.entrypoints.topics,
        validateTopics,
        "topic catalog input",
      )
    : undefined;
  assertUnique(
    insights.map((insight) => insight.id),
    "insight identity",
  );
  assertUnique(
    sources.map((source) => source.id),
    "source identity",
  );
  for (const insight of insights) {
    if (insight.domains && !insight.domains.some((domain) => domain === insight.domain)) {
      throw new Error(
        `insight domains must include primary domain: ${insight.id}/${insight.domain}`,
      );
    }
  }

  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const insightsById = new Map(insights.map((insight) => [insight.id, insight]));
  if (home.schemaVersion === 2) {
    const domainIds = home.domains.map((domainHome) => domainHome.domain.id);
    if (!domainIds.includes(home.defaultDomain)) {
      throw new Error("default editorial domain is unavailable");
    }
    assertUnique(domainIds, "editorial domain");
    for (const domainHome of home.domains) {
      const weekStart = Date.parse(`${domainHome.weeklyFocus.weekStart}T00:00:00Z`);
      const weekEnd = Date.parse(`${domainHome.weeklyFocus.weekEnd}T00:00:00Z`);
      const updatedAt = Date.parse(`${domainHome.status.updatedAt}T00:00:00Z`);
      if (
        !Number.isFinite(weekStart) ||
        !Number.isFinite(weekEnd) ||
        !Number.isFinite(updatedAt) ||
        new Date(weekStart).getUTCDay() !== 1 ||
        weekEnd - weekStart !== 6 * 24 * 60 * 60 * 1000 ||
        weekEnd >= updatedAt
      ) {
        throw new Error(
          `weekly focus must be a completed natural week: ${domainHome.domain.id}`,
        );
      }
      const daysSinceMonday = (new Date(updatedAt).getUTCDay() + 6) % 7;
      const currentWeekStart = updatedAt - daysSinceMonday * 24 * 60 * 60 * 1000;
      const expectedWeekEnd = currentWeekStart - 24 * 60 * 60 * 1000;
      const expectedWeekStart = expectedWeekEnd - 6 * 24 * 60 * 60 * 1000;
      if (weekStart !== expectedWeekStart || weekEnd !== expectedWeekEnd) {
        throw new Error(
          `weekly focus must be the most recent completed natural week: ${domainHome.domain.id}`,
        );
      }
      assertUnique(
        domainHome.weeklyFocus.sources.map((source) => source.name),
        `weekly source for ${domainHome.domain.id}`,
      );
      const selectedCount = domainHome.weeklyFocus.sources.reduce(
        (total, source) => total + source.count,
        0,
      );
      if (selectedCount !== domainHome.weeklyFocus.selectedCount) {
        throw new Error(
          `weekly source counts do not match selectedCount: ${domainHome.domain.id}`,
        );
      }
      assertUnique(
        domainHome.recentInsights.map((recent) => recent.insightId),
        `recent insight for ${domainHome.domain.id}`,
      );
      for (const recent of domainHome.recentInsights) {
        const insight = insightsById.get(recent.insightId);
        const insightDomains = insight?.domains ?? (insight ? [insight.domain] : []);
        if (!insight || !insightDomains.includes(domainHome.domain.id)) {
          throw new Error(
            `recent insight/domain mismatch: ${domainHome.domain.id}/${recent.insightId}`,
          );
        }
      }
    }
  }
  if (topics) {
    if (home.schemaVersion !== 2) {
      throw new Error("topic catalog requires the editorial home contract");
    }
    assertUnique(
      topics.topics.map((topic) => topic.id),
      "topic identity",
    );
    const availableDomains = new Set(home.domains.map((item) => item.domain.id));
    for (const topic of topics.topics) {
      const tagTypes = topic.tagFilters.map((filter) => filter.tagType);
      if (new Set(tagTypes).size !== tagTypes.length) {
        throw new Error(
          `invalid topic catalog input: duplicate tag type for ${topic.id}`,
        );
      }
      if (topic.domains.some((domain) => !availableDomains.has(domain))) {
        throw new Error(`topic references an unavailable editorial domain: ${topic.id}`);
      }
      const expectedMembers = insights
        .filter((insight) => matchesTopic(insight, topic))
        .map((insight) => insight.id)
        .sort();
      const declaredMembers = [...topic.currentMemberInsightIds].sort();
      if (expectedMembers.join("\n") !== declaredMembers.join("\n")) {
        throw new Error(`topic members do not match current insight tags: ${topic.id}`);
      }
      const judgment = topic.latestConfirmedJudgment;
      if (judgment) {
        if (
          judgment.topicVersion !== topic.version ||
          (judgment.sequence === 1 && judgment.evidence.articleCount < 4) ||
          judgment.evidence.sourceCount < 2 ||
          judgment.evidence.dateFrom > judgment.evidence.dateTo
        ) {
          throw new Error(`invalid confirmed topic judgment: ${topic.id}`);
        }
      }
    }
  }
  for (const insight of insights) {
    const source = sourcesById.get(insight.sourceId);
    if (
      !source ||
      source.insightId !== insight.id ||
      insight.sourceUrl !== sourceArchiveRoute(source.id) ||
      source.insightUrl !== insightRoute(insight.id) ||
      insight.citations.some((citation) => citation.sourceId !== source.id)
    ) {
      throw new Error(`insight/source reference mismatch: ${insight.id}`);
    }
    for (const related of [
      ...(insight.relations?.deterministic ?? []),
      ...(insight.relations?.modelDerived ?? []),
    ]) {
      if (
        related.targetInsightId === insight.id ||
        !insightsById.has(related.targetInsightId)
      ) {
        throw new Error(
          `insight relation target mismatch: ${insight.id}/${related.targetInsightId}`,
        );
      }
    }
  }
  for (const source of sources) {
    const insight = insightsById.get(source.insightId);
    if (
      !insight ||
      insight.sourceId !== source.id ||
      insight.sourceUrl !== sourceArchiveRoute(source.id) ||
      source.insightUrl !== insightRoute(insight.id)
    ) {
      throw new Error(`source/insight reference mismatch: ${source.id}`);
    }
  }

  const referencedAssets = new Set<string>([
    home.masthead.logoAssetPath,
    ...sources.flatMap((source) =>
      source.schemaVersion === 1
        ? (source.images ?? []).map((image) => image.assetPath)
        : (source.content ?? []).flatMap((block) =>
            block.kind === "image" ? [block.assetPath] : [],
          ),
    ),
    ...insights.flatMap((insight) =>
      insight.mechanism.blocks.flatMap((block) =>
        block.assetPath ? [block.assetPath] : [],
      ),
    ),
  ]);
  if (assets.get(home.masthead.logoAssetPath)?.mediaType !== "image/png") {
    throw new Error("home page logoAssetPath must reference a declared PNG asset");
  }
  for (const path of referencedAssets) {
    if (!assets.has(path)) {
      throw new Error(`content references an unavailable asset: ${path}`);
    }
  }
  for (const path of assets.keys()) {
    if (!referencedAssets.has(path)) {
      throw new Error(`manifest asset is not referenced by public content: ${path}`);
    }
  }

  return Object.freeze({
    root,
    publicationId: manifest.publicationId,
    candidate: Object.freeze({ ...manifest.candidate }),
    home: Object.freeze(home),
    insights: Object.freeze(insights),
    sources: Object.freeze(sources),
    ...(topics ? { topics: Object.freeze(topics) } : {}),
    assets,
  });
};
