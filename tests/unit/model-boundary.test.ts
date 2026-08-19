import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("content model boundary", () => {
  it("does not contain publication-input DTOs or physical layout fields", async () => {
    const modelRoot = join(process.cwd(), "src", "content", "model");
    const modelFiles = (await readdir(modelRoot)).filter((name) => name.endsWith(".ts"));

    for (const file of modelFiles) {
      const source = await readFile(join(modelRoot, file), "utf8");
      expect(source, file).not.toMatch(
        /\b(?:HomePublicationInput|VerifiedPublicationInput|VerifiedAsset|fullPath|logoAssetPath)\b/,
      );
    }
  });
});
