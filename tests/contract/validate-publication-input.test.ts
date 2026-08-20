import { appendFile, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
import { writePublicationFixture } from "../support/publication-fixture";

describe("validatePublicationInput", () => {
  it("returns a verified input for a complete, hash-bound publication", async () => {
    const fixture = await writePublicationFixture();

    const verified = await validatePublicationInput(fixture.root);

    expect(verified.publicationId).toBe(fixture.publicationId);
    expect(verified.home.domain.url).toBe("/software-engineering/");
    expect(verified.assets.get(fixture.logoPath)?.sha256).toBe(fixture.logoSha256);
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
