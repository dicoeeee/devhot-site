import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { listSafeFiles } from "../src/infrastructure/list-safe-files";

interface PublicationMetadata {
  readonly schemaVersion: 1;
  readonly publicationId: string;
  readonly buildSha: string;
  readonly routes: readonly string[];
  readonly assets: readonly {
    readonly url: string;
    readonly sha256: string;
    readonly mediaType: "image/png" | "image/svg+xml";
  }[];
}

interface VerifyDistributionOptions {
  readonly distRoot: string;
}

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const routeToFile = (distRoot: string, route: string): string => {
  if (route === "/") return join(distRoot, "index.html");
  if (!/^\/(?:[a-z0-9-]+\/)+$/.test(route)) {
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
        (asset.mediaType === "image/png" || asset.mediaType === "image/svg+xml") &&
        /^[a-f0-9]{64}$/.test(asset.sha256),
    )
  ) {
    throw new Error("publication metadata entries are invalid");
  }
  return metadata as PublicationMetadata;
};

export const verifyDistribution = async ({
  distRoot,
}: VerifyDistributionOptions): Promise<PublicationMetadata> => {
  const metadata = parseMetadata(
    JSON.parse(await readFile(join(distRoot, "_publication.json"), "utf8")) as unknown,
  );
  if (
    metadata.routes.length < 3 ||
    !metadata.routes.some((route) => route.startsWith("/insights/")) ||
    !metadata.routes.some((route) => route.startsWith("/sources/"))
  ) {
    throw new Error("the publication slice requires home, insight, and source routes");
  }
  if (new Set(metadata.routes).size !== metadata.routes.length) {
    throw new Error("publication metadata contains duplicate routes");
  }

  const outputFiles = await listSafeFiles(distRoot, "distribution");
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
    if (
      /\b(?:src|srcset)=["'](?:https?:)?\/\//i.test(source) ||
      /\b(?:url|import)\s*\(\s*["']?(?:https?:)?\/\//i.test(source) ||
      /\b(?:fetch|import)\s*\(\s*["'](?:https?:)?\/\//i.test(source)
    ) {
      throw new Error(`external runtime dependency found in ${path}`);
    }
  }

  const routeSet = new Set(metadata.routes);
  const outputFileSet = new Set(outputFiles);
  const timelineFragmentPaths = outputFiles.filter((path) =>
    /^timeline\/fragments\/(?:software-engineering|model-research)\/(?:day|week)\/\d{4}-\d{2}-\d{2}\.json$/.test(
      path,
    ),
  );
  if (routeSet.has("/timeline/") && timelineFragmentPaths.length === 0) {
    throw new Error("timeline route requires generated JSON fragments");
  }
  for (const path of timelineFragmentPaths) {
    const content = await readFile(join(distRoot, path));
    if (content.byteLength > 256 * 1024) {
      throw new Error(`timeline fragment exceeds 256 KiB: ${path}`);
    }
    const match = path.match(
      /^timeline\/fragments\/(software-engineering|model-research)\/(day|week)\/(\d{4}-\d{2}-\d{2})\.json$/,
    );
    const value = JSON.parse(content.toString("utf8")) as {
      readonly schemaVersion?: unknown;
      readonly identity?: unknown;
      readonly domainId?: unknown;
      readonly scale?: unknown;
      readonly before?: unknown;
      readonly groups?: unknown;
    };
    const domainId = match?.[1];
    const scale = match?.[2];
    const before = match?.[3];
    if (
      value.schemaVersion !== 1 ||
      value.domainId !== domainId ||
      value.scale !== scale ||
      value.before !== before ||
      value.identity !== `${domainId}:${scale}:${before}` ||
      !Array.isArray(value.groups)
    ) {
      throw new Error(`timeline fragment identity mismatch: ${path}`);
    }
    for (const group of value.groups) {
      if (
        !group ||
        typeof group !== "object" ||
        !("insights" in group) ||
        !Array.isArray(group.insights)
      ) {
        throw new Error(`timeline fragment group is invalid: ${path}`);
      }
      for (const insight of group.insights) {
        if (
          !insight ||
          typeof insight !== "object" ||
          !("url" in insight) ||
          typeof insight.url !== "string" ||
          !routeSet.has(insight.url)
        ) {
          throw new Error(`timeline fragment contains a broken insight route: ${path}`);
        }
      }
    }
  }
  for (const route of metadata.routes) {
    const htmlPath = routeToFile(distRoot, route);
    const html = await readFile(htmlPath, "utf8");
    const internalLinks = [...html.matchAll(/\bhref=["'](\/[^"']*)["']/gi)].map(
      (match) => match[1] ?? "",
    );
    for (const href of internalLinks) {
      if (href.startsWith("/media/")) continue;
      const hrefUrl = new URL(href, "https://devhot.invalid");
      const hrefPath = hrefUrl.pathname;
      if (outputFileSet.has(hrefPath.slice(1))) continue;
      const pageRoute =
        hrefPath === "/" || hrefPath.endsWith("/") ? hrefPath : `${hrefPath}/`;
      if (!routeSet.has(pageRoute)) {
        throw new Error(`broken internal link ${href} in ${route}`);
      }
    }
  }

  const allHtml = await Promise.all(
    metadata.routes.map((route) => readFile(routeToFile(distRoot, route), "utf8")),
  );
  for (const asset of metadata.assets) {
    if (!allHtml.some((html) => html.includes(asset.url))) {
      throw new Error(`no public page references ${asset.url}`);
    }
  }

  const expectedAssetNames = metadata.assets
    .map(
      (asset) => `${asset.sha256}.${asset.mediaType === "image/svg+xml" ? "svg" : "png"}`,
    )
    .sort();
  const mediaRoot = join(distRoot, "media", "sha256");
  const actualAssetNames = (await readdir(mediaRoot)).sort();
  if (actualAssetNames.join("\n") !== expectedAssetNames.join("\n")) {
    throw new Error("distribution media set differs from publication metadata");
  }
  for (const asset of metadata.assets) {
    const extension = asset.mediaType === "image/svg+xml" ? "svg" : "png";
    if (asset.url !== `/media/sha256/${asset.sha256}.${extension}`) {
      throw new Error(`asset URL is not content addressed: ${asset.url}`);
    }
    const fullPath = join(mediaRoot, `${asset.sha256}.${extension}`);
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
