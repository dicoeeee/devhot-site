import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, type DefaultTreeAdapterMap } from "parse5";

import { listSafeFiles } from "../src/infrastructure/list-safe-files";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

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

interface ReleaseMetadata {
  readonly schemaVersion: 1;
  readonly publicationId: string;
  readonly buildSha: string;
  readonly generatedAt: string;
}

interface MaintenanceReminders {
  readonly schemaVersion: 1;
  readonly reminders: readonly unknown[];
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

// —— 结构化 HTML 安全扫描（parse5 真实解析，不依赖可绕过的局部正则） ——

const EVENT_HANDLER_ATTRIBUTE = /^on[a-z]+$/i;

const isExternalReference = (value: string): boolean =>
  /^(?:https?:)?\/\//i.test(value.trim());

const walk = (node: Node, visit: (element: Element) => void): void => {
  if ("tagName" in node) {
    visit(node as Element);
  }
  if ("childNodes" in node) {
    for (const child of (node as Element).childNodes ?? []) {
      walk(child, visit);
    }
  }
};

const textOf = (element: Element): string =>
  (element.childNodes ?? [])
    .filter(
      (child): child is DefaultTreeAdapterMap["textNode"] => child.nodeName === "#text",
    )
    .map((child) => child.value)
    .join("")
    .trim();

export const scanHtmlSecurity = (html: string, path: string): void => {
  const document = parse(html, { sourceCodeLocationInfo: false });

  walk(document, (element) => {
    const tag = element.tagName.toLowerCase();
    const attributes = new Map(element.attrs.map((attr) => [attr.name, attr.value]));

    for (const attr of element.attrs) {
      if (EVENT_HANDLER_ATTRIBUTE.test(attr.name)) {
        throw new Error(
          `inline event handler attribute found in ${path}: ${tag} ${attr.name}`,
        );
      }
    }

    // 内联样式：style 属性与 <style> 块都不允许。
    if (attributes.has("style")) {
      throw new Error(`inline style attribute found in ${path}: <${tag} style=…>`);
    }
    if (tag === "style" && textOf(element).length > 0) {
      throw new Error(`inline style block found in ${path}`);
    }

    // 内联可执行脚本：type 缺省/module/text/javascript 且有正文即拒绝。
    if (tag === "script") {
      const type = attributes.get("type")?.toLowerCase();
      const executable =
        type === undefined ||
        type === "module" ||
        type === "text/javascript" ||
        type === "application/javascript";
      if (executable) {
        const src = attributes.get("src");
        if (src !== undefined && isExternalReference(src)) {
          throw new Error(
            `external runtime dependency found in ${path}: <script src="${src}">`,
          );
        }
        if (textOf(element).length > 0) {
          throw new Error(`inline executable script found in ${path}`);
        }
        if (src === undefined || !src.startsWith("/")) {
          throw new Error(`script without a same-origin src found in ${path}`);
        }
      }
    }

    // 第三方运行时资源：引用外部 URL 的加载型元素一律拒绝。
    const runtimeReferenceAttribute: Record<string, string> = {
      script: "src",
      img: "src",
      source: "src",
      video: "src",
      audio: "src",
      track: "src",
      embed: "src",
      iframe: "src",
      object: "data",
      link: "href",
      use: "href",
    };
    const referenceAttribute = runtimeReferenceAttribute[tag];
    if (referenceAttribute) {
      const value = attributes.get(referenceAttribute);
      if (value !== undefined && isExternalReference(value)) {
        throw new Error(
          `external runtime dependency found in ${path}: <${tag} ${referenceAttribute}="${value}">`,
        );
      }
      if (tag === "link") {
        const rel = attributes.get("rel")?.toLowerCase() ?? "";
        const preloadLike = rel
          .split(/\s+/)
          .some((token) =>
            [
              "preload",
              "modulepreload",
              "prefetch",
              "preconnect",
              "dns-prefetch",
            ].includes(token),
          );
        if (preloadLike) {
          const href = attributes.get("href");
          if (href === undefined || isExternalReference(href) || !href.startsWith("/")) {
            throw new Error(`non-same-origin preload link found in ${path}: ${rel}`);
          }
        }
      }
    }
    // srcset 上的外部引用同样拒绝。
    for (const attr of element.attrs) {
      if (attr.name === "srcset" || attr.name === "imagesrcset") {
        const candidates = attr.value
          .split(",")
          .map((part) => part.trim().split(/\s+/)[0] ?? "");
        if (candidates.some((candidate) => isExternalReference(candidate))) {
          throw new Error(
            `external runtime dependency found in ${path}: ${tag} ${attr.name}`,
          );
        }
      }
    }
  });
};

const scanScriptSecurity = (source: string, path: string): void => {
  if (/serviceWorker\s*\.\s*register\s*\(/i.test(source)) {
    throw new Error(`service worker registration found in ${path}`);
  }
  for (const match of source.matchAll(
    /\b(?:fetch|import)\s*\(\s*(["'])((?:https?:)?\/\/[^"']*)\1/gi,
  )) {
    throw new Error(
      `external runtime dependency found in ${path}: ${match[1]}${match[2]}`,
    );
  }
  if (/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(source)) {
    throw new Error(`inline event handler attribute found in ${path}`);
  }
};

const scanStyleSecurity = (source: string, path: string): void => {
  if (/@import\s+(?:url\()?\s*(["']?)(?:https?:)?\/\//i.test(source)) {
    throw new Error(`external runtime dependency found in ${path}`);
  }
  if (/url\s*\(\s*(["']?)(?:https?:)?\/\//i.test(source)) {
    throw new Error(`external runtime dependency found in ${path}`);
  }
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
  if (
    !metadata.routes.some((route) => route.startsWith("/topics/")) ||
    !metadata.routes.some((route) => route.endsWith("/topics/"))
  ) {
    throw new Error("the seven reader pages require topic routes");
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
    if (path.endsWith(".html")) {
      scanHtmlSecurity(source, path);
    } else if (path.endsWith(".js")) {
      scanScriptSecurity(source, path);
    } else {
      scanStyleSecurity(source, path);
    }
  }

  const release = JSON.parse(
    await readFile(join(distRoot, "release.json"), "utf8"),
  ) as unknown as Partial<ReleaseMetadata>;
  if (
    release.schemaVersion !== 1 ||
    release.publicationId !== metadata.publicationId ||
    release.buildSha !== metadata.buildSha ||
    typeof release.generatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      release.generatedAt,
    )
  ) {
    throw new Error("release metadata is invalid or does not match the publication");
  }

  const reminders = JSON.parse(
    await readFile(join(distRoot, "maintenance", "reminders.json"), "utf8"),
  ) as unknown as Partial<MaintenanceReminders>;
  if (reminders.schemaVersion !== 1 || !Array.isArray(reminders.reminders)) {
    throw new Error("maintenance reminders metadata is invalid");
  }
  const maintenanceFiles = outputFiles.filter((path) => path.startsWith("maintenance/"));
  if (maintenanceFiles.join("\n") !== "maintenance/reminders.json") {
    throw new Error("maintenance status must only publish desensitized JSON");
  }
  const reportRoutes = metadata.routes.filter((route) =>
    /\/(?:reports?|daily|weekly|admin)(?:\/|$)/.test(route),
  );
  if (reportRoutes.length > 0) {
    throw new Error(`report or maintenance HTML routes are forbidden: ${reportRoutes}`);
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
