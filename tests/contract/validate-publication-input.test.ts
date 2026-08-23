import { appendFile, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
import { writePublicationFixture } from "../support/publication-fixture";

describe("validatePublicationInput", () => {
  it("rejects a v2 source archive that omits required integrity evidence", async () => {
    const fixture = await writePublicationFixture({
      evidenceReadingContract: true,
      omitRequiredArchiveEvidence: true,
    });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "invalid source input",
    );
  });

  it.each(["empty-blocks", "empty-evidence"] as const)(
    "rejects an insight with an invalid mechanism evidence contract: %s",
    async (invalidMechanismContract) => {
      const fixture = await writePublicationFixture({
        evidenceReadingContract: true,
        invalidMechanismContract,
      });

      await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
        "invalid insight input",
      );
    },
  );

  it("rejects citations that do not exactly match mechanism evidence", async () => {
    const fixture = await writePublicationFixture({
      evidenceReadingContract: true,
      mismatchedCitationEvidence: true,
    });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "insight citation evidence mismatch",
    );
  });

  it.each(["direction", "overflow", "unknown-type"] as const)(
    "rejects an insight with an invalid related-reading contract: %s",
    async (invalidRelationContract) => {
      const fixture = await writePublicationFixture({
        evidenceReadingContract: true,
        invalidRelationContract,
      });

      await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
        "invalid insight input",
      );
    },
  );

  it("returns a verified input for a complete, hash-bound publication", async () => {
    const fixture = await writePublicationFixture();

    const verified = await validatePublicationInput(fixture.root);

    expect(verified.publicationId).toBe(fixture.publicationId);
    expect(verified.home).toMatchObject({
      schemaVersion: 2,
      defaultDomain: "software-engineering",
      domains: [
        {
          domain: { id: "software-engineering" },
          weeklyFocus: { overview: "冻结的软件工程周度概览。" },
          recentInsights: [{ insightId: fixture.insightId, status: "new" }],
        },
        {
          domain: { id: "model-research" },
          weeklyFocus: { overview: "冻结的模型研发周度概览。" },
          recentInsights: [
            { insightId: "insight-000000000000000000000002", status: "updated" },
          ],
        },
      ],
    });
    expect(verified.assets.get(fixture.logoPath)?.sha256).toBe(fixture.logoSha256);
    expect(verified.topics).toMatchObject({
      schemaVersion: 1,
      matchingRulesVersion: "same-type-or-cross-type-and-v1",
      topics: [
        {
          id: fixture.topicId,
          version: 3,
          latestConfirmedJudgment: {
            topicVersion: 3,
            matchingRulesVersion: "same-type-or-cross-type-and-v1",
          },
        },
        { id: "evaluation-boundaries", version: 1 },
      ],
    });
  });

  it("continues to accept the legacy extensible-domain home contract", async () => {
    const fixture = await writePublicationFixture({
      legacyHomeContract: true,
      invalidEditorialDomain: true,
    });

    const verified = await validatePublicationInput(fixture.root);

    expect(verified.home).toMatchObject({
      schemaVersion: 1,
      domain: { id: "operations", url: "/operations/" },
    });
  });

  it("continues to accept editorial input before the optional topic contract", async () => {
    const fixture = await writePublicationFixture({ omitTopics: true });

    const verified = await validatePublicationInput(fixture.root);

    expect(verified.home.schemaVersion).toBe(2);
    expect(verified.topics).toBeUndefined();
  });

  it("preserves a versioned topic when its current member set is empty", async () => {
    const fixture = await writePublicationFixture({ emptyTopic: true });

    const verified = await validatePublicationInput(fixture.root);

    expect(verified.topics?.topics[0]).toMatchObject({
      id: fixture.topicId,
      currentMemberInsightIds: [],
    });
  });

  it("rejects a judgment bound to a different topic definition version", async () => {
    const fixture = await writePublicationFixture({ topicJudgmentVersion: 2 });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "invalid confirmed topic judgment",
    );
  });

  it("accepts one insight on both domain homes with one shared identity", async () => {
    const fixture = await writePublicationFixture({
      insightDomainMembership: "shared",
    });

    const verified = await validatePublicationInput(fixture.root);
    if (verified.home.schemaVersion !== 2) throw new Error("expected editorial home");

    expect(verified.insights[0]).toMatchObject({
      id: fixture.insightId,
      domain: "software-engineering",
      domains: ["software-engineering", "model-research"],
    });
    expect(
      verified.home.domains.map((home) => home.recentInsights[0]?.insightId),
    ).toEqual([fixture.insightId, fixture.insightId]);
  });

  it("rejects insight domains that omit the legacy primary domain", async () => {
    const fixture = await writePublicationFixture({
      insightDomainMembership: "missing-primary",
    });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "insight domains must include primary domain",
    );
  });

  it.each(["duplicate", "empty", "overflow", "unknown"] as const)(
    "rejects invalid insight domain membership: %s",
    async (insightDomainMembership) => {
      const fixture = await writePublicationFixture({ insightDomainMembership });

      await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
        "invalid insight input",
      );
    },
  );

  it("rejects a recent selection that repeats an insight", async () => {
    const fixture = await writePublicationFixture({
      recentInsightSelection: "duplicate",
    });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "duplicate recent insight",
    );
  });

  it("rejects a recent selection from another domain", async () => {
    const fixture = await writePublicationFixture({
      recentInsightSelection: "cross-domain",
    });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "recent insight/domain mismatch",
    );
  });

  it.each([
    [
      { duplicateEditorialDomain: "model-research" as const },
      "default editorial domain is unavailable",
    ],
    [
      { duplicateEditorialDomain: "software-engineering" as const },
      "duplicate editorial domain",
    ],
    [
      { weeklySourceCounts: "mismatch" as const },
      "weekly source counts do not match selectedCount",
    ],
    [{ weeklySourceCounts: "duplicate" as const }, "duplicate weekly source"],
    [{ invalidWeeklyRange: true }, "weekly focus must be a completed natural week"],
    [
      { staleWeeklyRange: true },
      "weekly focus must be the most recent completed natural week",
    ],
  ])("rejects an incoherent editorial domain projection (%s)", async (options, error) => {
    const fixture = await writePublicationFixture(options);

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(error);
  });

  it.each([
    [{ invalidEditorialDomain: true }, "unknown domain"],
    [{ missingWeeklyOverview: true }, "missing frozen weekly overview"],
    [{ recentInsightSelection: "empty" as const }, "zero recent insights"],
    [{ recentInsightSelection: "overflow" as const }, "more than five insights"],
  ])("rejects editorial input with %s (%s)", async (options, _description) => {
    const fixture = await writePublicationFixture(options);

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "invalid home page input",
    );
  });

  it("rejects a physical file that the manifest did not declare", async () => {
    const fixture = await writePublicationFixture();
    await writeFile(`${fixture.root}/not-public.txt`, "private draft");

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "publication file set differs from manifest",
    );
  });

  it("rejects content changed after its manifest hash was recorded", async () => {
    const fixture = await writePublicationFixture();
    await appendFile(`${fixture.root}/data/home.json`, "\n");

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "sha256 mismatch for data/home.json",
    );
  });

  it("rejects a page reference that is not backed by a declared asset", async () => {
    const fixture = await writePublicationFixture({ danglingLogoReference: true });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "logoAssetPath must reference a declared PNG asset",
    );
  });

  it("rejects a manifest asset that no public content object references", async () => {
    const fixture = await writePublicationFixture({ unreferencedAsset: true });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "manifest asset is not referenced by public content",
    );
  });

  it("rejects a declared JSON file that is not a typed entrypoint", async () => {
    const fixture = await writePublicationFixture({ unreferencedJson: true });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "manifest JSON files must exactly match typed entrypoints",
    );
  });

  it.each(["duplicate-type", "nested", "not"] as const)(
    "rejects a topic rule outside flat same-type OR / cross-type AND semantics: %s",
    async (topicRuleViolation) => {
      const fixture = await writePublicationFixture({ topicRuleViolation });

      await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
        "invalid topic catalog input",
      );
    },
  );

  it("rejects a topic member projection that does not match its frozen tag filters", async () => {
    const fixture = await writePublicationFixture({
      topicRuleViolation: "member-mismatch",
    });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "topic members do not match current insight tags",
    );
  });

  it("rejects a source that claims an insight owned by another source", async () => {
    const fixture = await writePublicationFixture({
      extraSourceReferencingInsight: true,
    });

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "source/insight reference mismatch",
    );
  });

  it("rejects a candidate identity that does not match its frozen input", async () => {
    const fixture = await writePublicationFixture();
    const manifestPath = `${fixture.root}/manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const forgedIdentity = "f".repeat(64);
    manifest.candidate.inputIdentity = forgedIdentity;
    manifest.publicationId = `candidate-${forgedIdentity.slice(0, 24)}`;
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "candidate input identity does not match manifest content",
    );
  });

  it("binds the publication identity to the verified input identity", async () => {
    const fixture = await writePublicationFixture();
    const manifestPath = `${fixture.root}/manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.publicationId = "forged-publication";
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "publicationId must be derived from candidate inputIdentity",
    );
  });
});
