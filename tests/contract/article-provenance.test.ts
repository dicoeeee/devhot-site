import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  calculatePublicationInputIdentity,
  calculateSourceContentSha256,
  publicationIdFor,
} from "../../src/content/adapters/publication-input/publication-identity";
import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
import { createSiteContentRepository } from "../../src/content/composition-root";
import { writePublicationFixture } from "../support/publication-fixture";

// 重新绑定 manifest，证明失败来自文章契约而不是外层文件完整性校验。
const rewriteFixtureJson = async (
  root: string,
  path: string,
  mutate: (value: Record<string, unknown>) => void,
): Promise<void> => {
  const value = JSON.parse(await readFile(`${root}/${path}`, "utf8"));
  mutate(value);
  const text = JSON.stringify(value);
  await writeFile(`${root}/${path}`, text);
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
  const file = manifest.files.find((entry: { path: string }) => entry.path === path);
  file.sha256 = createHash("sha256").update(text).digest("hex");
  manifest.candidate.inputIdentity = calculatePublicationInputIdentity({
    baselineSha: manifest.candidate.baselineSha,
    entrypoints: manifest.entrypoints,
    files: manifest.files,
  });
  manifest.publicationId = publicationIdFor(manifest.candidate.inputIdentity);
  await writeFile(`${root}/manifest.json`, JSON.stringify(manifest));
};

describe("article-level insight provenance v3", () => {
  it.each(["missing", "empty", "present"] as const)(
    "preserves valid explanation, image, Mermaid, and tags with %s optional references",
    async (optionalReferences) => {
      const fixture = await writePublicationFixture({
        articleProvenanceContract: true,
        mermaidMechanismContract: true,
        optionalReferences,
      });
      const verified = await validatePublicationInput(fixture.root);
      const repository = await createSiteContentRepository(fixture.root);
      const insight = (await repository.listInsights()).find(
        (value) => value.id === fixture.insightId,
      );

      expect(verified.insights[0]).toMatchObject({
        schemaVersion: 3,
        provenance: {
          sourceId: fixture.sourceId,
          contentSha256: "a".repeat(64),
          analysisFingerprint: "c".repeat(64),
        },
      });
      expect(insight?.mechanism.blocks.map((block) => block.kind)).toEqual([
        "text",
        "source_image",
        "technical_flow_mermaid",
      ]);
      expect(insight?.mechanism.blocks[1]?.visual).toMatchObject({
        alt: "冻结输入架构图",
      });
      expect(insight?.mechanism.blocks[2]?.visual).toMatchObject({
        alt: "冻结后校验的技术流程",
      });
      expect(insight?.keyInterpretation).toBe("关键变化是把输出绑定到可审计输入。");
      expect(insight?.tags).toHaveLength(2);
      expect(insight?.citations).toHaveLength(optionalReferences === "present" ? 1 : 0);
      expect(insight).not.toHaveProperty("provenance");
    },
  );

  it.each(["citations", "evidenceRefs"])(
    "accepts independently omitted optional %s",
    async (field) => {
      const fixture = await writePublicationFixture({
        articleProvenanceContract: true,
        optionalReferences: "present",
      });
      await rewriteFixtureJson(
        fixture.root,
        `data/insights/${fixture.insightId}.json`,
        (insight) => {
          if (field === "citations") delete insight.citations;
          else {
            for (const block of (
              insight.mechanism as { blocks: Record<string, unknown>[] }
            ).blocks)
              delete block.evidenceRefs;
          }
        },
      );
      await expect(validatePublicationInput(fixture.root)).resolves.toBeDefined();
    },
  );

  it("isolates a cross-source optional citation without rejecting article content or rewriting frozen input", async () => {
    const fixture = await writePublicationFixture({
      articleProvenanceContract: true,
      optionalReferences: "present",
    });
    const path = `data/insights/${fixture.insightId}.json`;
    await rewriteFixtureJson(fixture.root, path, (insight) => {
      (insight.citations as Record<string, unknown>[]).push({
        sourceId: "source-000000000000000000000002",
        evidenceId: "foreign-evidence",
        quote: "Foreign article quote.",
      });
    });
    const frozen = await readFile(`${fixture.root}/${path}`, "utf8");
    const verified = await validatePublicationInput(fixture.root);
    expect(verified.insights[0]?.citations).toHaveLength(1);
    const repository = await createSiteContentRepository(fixture.root);
    const insight = (await repository.listInsights()).find(
      (value) => value.id === fixture.insightId,
    );
    expect(insight?.summary).toBe("不可变输入让自动化结果可重放。");
    expect(insight?.mechanism.blocks).toHaveLength(2);
    expect(insight?.citations).toHaveLength(1);
    expect(await readFile(`${fixture.root}/${path}`, "utf8")).toBe(frozen);
    expect(JSON.parse(frozen).citations).toHaveLength(2);
  });

  it.each(["sourceId", "contentSha256", "sourceContentSha256", "analysisFingerprint"])(
    "rejects missing mandatory provenance field %s",
    async (field) => {
      const fixture = await writePublicationFixture({ articleProvenanceContract: true });
      await rewriteFixtureJson(
        fixture.root,
        `data/insights/${fixture.insightId}.json`,
        (insight) => {
          delete (insight.provenance as Record<string, unknown>)[field];
        },
      );
      await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
        "invalid insight input",
      );
    },
  );

  it.each(["sourceId", "contentSha256", "sourceContentSha256"])(
    "rejects mismatched article provenance field %s",
    async (field) => {
      const fixture = await writePublicationFixture({ articleProvenanceContract: true });
      await rewriteFixtureJson(
        fixture.root,
        `data/insights/${fixture.insightId}.json`,
        (insight) => {
          (insight.provenance as Record<string, unknown>)[field] =
            field === "sourceId" ? "source-000000000000000000000002" : "f".repeat(64);
        },
      );
      await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
        "insight article provenance mismatch",
      );
    },
  );

  it("rejects a forged result fingerprint shape", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    await rewriteFixtureJson(
      fixture.root,
      `data/insights/${fixture.insightId}.json`,
      (insight) => {
        (insight.provenance as Record<string, unknown>).analysisFingerprint =
          "not-a-fingerprint";
      },
    );
    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "invalid insight input",
    );
  });

  it("rejects changed public full text even after manifest hashes are recomputed", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    await rewriteFixtureJson(
      fixture.root,
      `data/sources/${fixture.sourceId}.json`,
      (source) => {
        (source.content as { text: string }[])[0]!.text = "A forged article body.";
      },
    );
    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "insight article provenance mismatch",
    );
  });

  it("rejects a v3 insight whose associated source uses a legacy body", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    await rewriteFixtureJson(
      fixture.root,
      `data/sources/${fixture.sourceId}.json`,
      (source) => {
        source.schemaVersion = 1;
        delete source.content;
        delete source.archive;
        source.body = {
          format: "markdown",
          parts: ["Reliable agents use immutable inputs."],
        };
        source.images = [
          { assetPath: fixture.logoPath, alt: "Architecture", position: 1 },
        ];
      },
    );
    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "insight article provenance mismatch",
    );
  });

  it("retains partial image archives when the frozen full-text projection is bound", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    await rewriteFixtureJson(
      fixture.root,
      `data/sources/${fixture.sourceId}.json`,
      (source) => {
        (source.archive as Record<string, unknown>).completeness = "partial";
      },
    );
    await expect(validatePublicationInput(fixture.root)).resolves.toBeDefined();
  });

  it("rejects an official original entry from a different article", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    await rewriteFixtureJson(
      fixture.root,
      `data/insights/${fixture.insightId}.json`,
      (insight) => {
        insight.officialUrl = "https://example.com/a-different-article";
      },
    );
    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "insight article provenance mismatch",
    );
  });

  it("rejects a source image owned only by another article", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    await rewriteFixtureJson(
      fixture.root,
      `data/insights/${fixture.insightId}.json`,
      (insight) => {
        const foreignSource = "source-000000000000000000000002";
        insight.sourceId = foreignSource;
        insight.sourceUrl = `/sources/${foreignSource}/`;
      },
    );
    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "insight/source reference mismatch",
    );
  });

  it("rejects an image absent from the associated article even when globally declared", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    await rewriteFixtureJson(
      fixture.root,
      `data/sources/${fixture.sourceId}.json`,
      (source) => {
        source.content = (source.content as { kind: string }[]).filter(
          (block) => block.kind !== "image",
        );
      },
    );
    const source = JSON.parse(
      await readFile(`${fixture.root}/data/sources/${fixture.sourceId}.json`, "utf8"),
    );
    await rewriteFixtureJson(
      fixture.root,
      `data/insights/${fixture.insightId}.json`,
      (insight) => {
        (insight.provenance as Record<string, unknown>).sourceContentSha256 =
          calculateSourceContentSha256(source.content);
      },
    );
    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "insight mechanism asset ownership mismatch",
    );
  });

  it.each(["source_image", "technical_flow_mermaid"])(
    "rejects the wrong media type for %s",
    async (kind) => {
      const fixture = await writePublicationFixture({
        articleProvenanceContract: true,
        mermaidMechanismContract: true,
      });
      await rewriteFixtureJson(
        fixture.root,
        `data/insights/${fixture.insightId}.json`,
        (insight) => {
          const blocks = (insight.mechanism as { blocks: Record<string, unknown>[] })
            .blocks;
          const block = blocks.find((value) => value.kind === kind)!;
          block.assetPath =
            kind === "source_image" ? blocks[2]!.assetPath : fixture.logoPath;
        },
      );
      await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
        "insight mechanism asset ownership mismatch",
      );
    },
  );

  it("rejects a v3 publication that declares an older consumer version", async () => {
    const fixture = await writePublicationFixture({ articleProvenanceContract: true });
    const path = `${fixture.root}/manifest.json`;
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.builderCompatibility.min = "0.6.0";
    await writeFile(path, JSON.stringify(manifest));
    await expect(validatePublicationInput(fixture.root)).rejects.toThrow(
      "article provenance v3 requires builderCompatibility.min >= 0.7.0",
    );
  });

  it.each([false, true])(
    "accepts legacy inputs with consumer minimum 0.5.0 (v2=%s)",
    async (evidenceReadingContract) => {
      const fixture = await writePublicationFixture({ evidenceReadingContract });
      const path = `${fixture.root}/manifest.json`;
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.builderCompatibility.min = "0.5.0";
      await writeFile(path, JSON.stringify(manifest));
      await expect(validatePublicationInput(fixture.root)).resolves.toBeDefined();
    },
  );

  it("matches the shared Python/TypeScript canonical full-text hash vector", async () => {
    const vector = JSON.parse(
      await readFile(
        new URL("../fixtures/source-content-sha256.json", import.meta.url),
        "utf8",
      ),
    );
    expect(calculateSourceContentSha256(vector.content)).toBe(vector.sha256);
    expect(createHash("sha256").update(vector.canonicalJson).digest("hex")).toBe(
      vector.sha256,
    );
    const reordered = vector.content.map((block: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(block).reverse()),
    );
    expect(calculateSourceContentSha256(reordered)).toBe(vector.sha256);
    expect(calculateSourceContentSha256([...reordered].reverse())).not.toBe(
      vector.sha256,
    );
  });
});
