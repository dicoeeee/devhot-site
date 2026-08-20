import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { validatePublicationInput } from "../src/content/adapters/publication-input/validate-publication-input";
import {
  insightRoute,
  mediaAssetRoute,
  sourceArchiveRoute,
} from "../src/content/model/site-routes";

const execFileAsync = promisify(execFile);

interface CopyDeclaredAssetsOptions {
  readonly inputRoot: string;
  readonly distRoot: string;
}

const resolveBuildSha = async (): Promise<string> => {
  const environmentSha =
    process.env["DEVHOT_SITE_BUILD_SHA"] ?? process.env["GITHUB_SHA"];
  if (environmentSha) return environmentSha;

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
    });
    return stdout.trim();
  } catch {
    return "uncommitted";
  }
};

export const copyDeclaredAssets = async ({
  inputRoot,
  distRoot,
}: CopyDeclaredAssetsOptions): Promise<void> => {
  const input = await validatePublicationInput(inputRoot);
  const mediaRoot = join(distRoot, "media", "sha256");
  await rm(join(distRoot, "media"), { recursive: true, force: true });
  await mkdir(mediaRoot, { recursive: true });

  const assets = [...input.assets.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  for (const asset of assets) {
    await copyFile(asset.fullPath, join(mediaRoot, `${asset.sha256}.png`));
  }

  const metadata = {
    schemaVersion: 1,
    publicationId: input.publicationId,
    buildSha: await resolveBuildSha(),
    routes: [
      input.home.domain.url,
      ...input.insights.map((insight) => insightRoute(insight.id)),
      ...input.sources.map((source) => sourceArchiveRoute(source.id)),
    ].sort(),
    assets: assets.map((asset) => ({
      url: mediaAssetRoute(asset.sha256),
      sha256: asset.sha256,
    })),
  };
  await writeFile(
    join(distRoot, "_publication.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { mode: 0o644 },
  );
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await copyDeclaredAssets({
    inputRoot: join(process.cwd(), "site-input"),
    distRoot: join(process.cwd(), "dist"),
  });
  console.log("Copied manifest-declared assets and wrote publication metadata");
}
