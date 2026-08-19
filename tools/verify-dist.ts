import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface PublicationMetadata {
  readonly schemaVersion: 1;
  readonly publicationId: string;
  readonly buildSha: string;
  readonly routes: readonly string[];
  readonly assets: readonly { readonly url: string; readonly sha256: string }[];
}

interface VerifyDistributionOptions {
  readonly distRoot: string;
}

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const routeToFile = (distRoot: string, route: string): string => {
  if (!/^\/[a-z0-9-]+\/$/.test(route)) {
    throw new Error(`invalid static route: ${route}`);
  }
  return join(distRoot, route.slice(1), "index.html");
};

const parseMetadata = (value: unknown): PublicationMetadata => {
  if (!value || typeof value !== "object") {
    throw new Error("publication metadata must be an object");
  }
  const metadata = value as Partial<PublicationMetadata>;
  if (
    metadata.schemaVersion !== 1 ||
    typeof metadata.publicationId !== "string" ||
    metadata.publicationId.length === 0 ||
    typeof metadata.buildSha !== "string" ||
    !/^(?:[a-f0-9]{40}|uncommitted)$/.test(metadata.buildSha) ||
    !Array.isArray(metadata.routes) ||
    !Array.isArray(metadata.assets)
  ) {
    throw new Error("publication metadata is invalid");
  }
  if (
    !metadata.routes.every((route) => typeof route === "string") ||
    !metadata.assets.every(
      (asset) =>
        asset !== null &&
        typeof asset === "object" &&
        typeof asset.url === "string" &&
        typeof asset.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(asset.sha256),
    )
  ) {
    throw new Error("publication metadata entries are invalid");
  }
  return metadata as PublicationMetadata;
};

const listOutputFiles = async (root: string, directory = root): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`distribution must not contain symlinks: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      paths.push(...(await listOutputFiles(root, fullPath)));
    } else if (entry.isFile()) {
      paths.push(relative(root, fullPath).split(sep).join("/"));
    } else {
      throw new Error(`distribution contains unsupported file type: ${entry.name}`);
    }
  }
  return paths.sort();
};

export const verifyDistribution = async ({
  distRoot,
}: VerifyDistributionOptions): Promise<PublicationMetadata> => {
  const metadata = parseMetadata(
    JSON.parse(await readFile(join(distRoot, "_publication.json"), "utf8")) as unknown,
  );
  if (metadata.routes.length !== 1) {
    throw new Error("the minimum slice must publish exactly one reader route");
  }
  if (new Set(metadata.routes).size !== metadata.routes.length) {
    throw new Error("publication metadata contains duplicate routes");
  }

  const outputFiles = await listOutputFiles(distRoot);
  const expectedHtmlFiles = metadata.routes
    .map((route) => relative(distRoot, routeToFile(distRoot, route)).split(sep).join("/"))
    .sort();
  const actualHtmlFiles = outputFiles.filter((path) => path.endsWith(".html"));
  if (actualHtmlFiles.join("\n") !== expectedHtmlFiles.join("\n")) {
    throw new Error("distribution HTML routes differ from publication metadata");
  }
  for (const path of outputFiles.filter((candidate) =>
    /\.(?:css|html|js)$/.test(candidate),
  )) {
    const source = await readFile(join(distRoot, path), "utf8");
    if (/https?:\/\//i.test(source)) {
      throw new Error(`external runtime dependency found in ${path}`);
    }
  }

  const routeSet = new Set(metadata.routes);
  for (const route of metadata.routes) {
    const htmlPath = routeToFile(distRoot, route);
    const html = await readFile(htmlPath, "utf8");
    const internalLinks = [...html.matchAll(/\bhref=["'](\/[^"']*)["']/gi)].map(
      (match) => match[1] ?? "",
    );
    for (const href of internalLinks) {
      if (href.startsWith("/media/")) continue;
      if (!routeSet.has(href)) {
        throw new Error(`broken internal link ${href} in ${route}`);
      }
    }
    for (const asset of metadata.assets) {
      if (!html.includes(asset.url)) {
        throw new Error(`page ${route} does not reference ${asset.url}`);
      }
    }
  }

  const expectedAssetNames = metadata.assets.map((asset) => `${asset.sha256}.png`).sort();
  const mediaRoot = join(distRoot, "media", "sha256");
  const actualAssetNames = (await readdir(mediaRoot)).sort();
  if (actualAssetNames.join("\n") !== expectedAssetNames.join("\n")) {
    throw new Error("distribution media set differs from publication metadata");
  }
  for (const asset of metadata.assets) {
    if (asset.url !== `/media/sha256/${asset.sha256}.png`) {
      throw new Error(`asset URL is not content addressed: ${asset.url}`);
    }
    const fullPath = join(mediaRoot, `${asset.sha256}.png`);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile() || (fileStat.mode & 0o111) !== 0) {
      throw new Error(`invalid output asset mode: ${asset.url}`);
    }
    if (sha256(await readFile(fullPath)) !== asset.sha256) {
      throw new Error(`output asset hash mismatch: ${asset.url}`);
    }
  }

  return metadata;
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const metadata = await verifyDistribution({
    distRoot: join(process.cwd(), "dist"),
  });
  console.log(
    `Verified ${metadata.routes.length} route(s) for ${metadata.publicationId}`,
  );
}
