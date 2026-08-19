import { appendFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
import { writePublicationFixture } from "../support/publication-fixture";

describe("validatePublicationInput", () => {
  it("returns a verified input for a complete, hash-bound publication", async () => {
    const fixture = await writePublicationFixture();

    const verified = await validatePublicationInput(fixture.root);

    expect(verified.publicationId).toBe("fixture-2026-08-19");
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
});
