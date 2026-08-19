import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PublicationFixtureOptions {
  readonly danglingLogoReference?: boolean;
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

  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "assets", "sha256"), { recursive: true });
  await writeFile(join(root, "data", "home.json"), home);
  await writeFile(join(root, logoPath), logo);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      publicationId: "fixture-2026-08-19",
      builderCompatibility: { min: "0.1.0", maxExclusive: "1.0.0" },
      entrypoints: { home: "data/home.json" },
      files: [
        {
          path: "data/home.json",
          mediaType: "application/json",
          sha256: sha256(home),
        },
        {
          path: logoPath,
          mediaType: "image/png",
          sha256: logoSha256,
        },
      ],
    }),
  );

  return { root, logoPath, logoSha256 };
};
