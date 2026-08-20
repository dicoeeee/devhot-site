import { appendFile, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
import { writePublicationFixture } from "../support/publication-fixture";

describe("validatePublicationInput", () => {
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
