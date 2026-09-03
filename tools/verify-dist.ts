import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseScript, type Node as AcornNode } from "acorn";
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

// WHATWG URL 风格输入预处理（https://url.spec.whatwg.org/#url-parsing）：
// 1. 删除任意位置的 ASCII TAB（U+0009）、LF（U+000A）、CR（U+000D）；
// 2. 删除首尾全部 C0 control（U+0000–U+001F）与 space（U+0020）。
// 浏览器会把 "\u0000https://…"、"ht\ntps://…" 等解析为真实外部 URL，
// 因此 scheme 判断必须在同一规范化之后进行。JS、HTML、CSS 的所有 URL
// 检查共用本函数。
export const normalizeUrlValue = (value: string): string =>
  value
    .replace(/[\u0009\u000A\u000D]/g, "")
    .replace(/^[\u0000-\u0020]+/, "")
    .replace(/[\u0000-\u0020]+$/, "");

const isExternalReference = (value: string): boolean =>
  /^(?:https?:)?\/\//i.test(normalizeUrlValue(value));

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

// 生成 JS 的第三方连接检查基于 AST（acorn）：
// - StringLiteral、无插值模板字符串、含插值模板的每个 quasi 都按值检查；
// - 检查前先 trim() 两端空白（URL parser 会忽略前导空白）；
// - 拒绝大小写不敏感的 http://、https://、ws://、wss:// 与协议相对 // 第三方 URL；
// - 站内相对 URL（如 /timeline/fragments/...）不受影响；
// - Worker/SharedWorker 构造（Identifier、window/globalThis/self 成员形式、
//   可静态确定的 computed property）一律拒绝，不论参数来源；
// - 并保留 service worker 注册与内联事件处理属性的既有拒绝策略。
const isExternalScriptUrl = (value: string): boolean => {
  const normalized = normalizeUrlValue(value);
  return /^(?:https?|wss?):\/\//i.test(normalized) || normalized.startsWith("//");
};

// 模板字符串按前缀判定：任一 quasi（trim 后）以第三方 scheme 开头即拒绝，
// 含 ${} 插值的模板无法静态证明其最终值，同样按前缀拒绝。
const templateIsExternal = (node: AcornNode): string | undefined => {
  const template = node as unknown as {
    quasis?: { value: { cooked: string | null } }[];
  };
  for (const quasi of template.quasis ?? []) {
    const cooked = quasi.value.cooked;
    if (cooked !== null && isExternalScriptUrl(cooked)) return cooked;
  }
  return undefined;
};

// callee 的静态可读名称：Identifier（Worker）、全局成员（window.Worker、
// globalThis.SharedWorker、self.Worker）与 computed 形式（window["Worker"]）。
const WORKER_GLOBALS = new Set(["window", "globalThis", "self"]);
const WORKER_CONSTRUCTORS = new Set(["Worker", "SharedWorker"]);

const calleeConstructorName = (callee: AcornNode): string | undefined => {
  const node = callee as unknown as {
    type: string;
    name?: string;
    object?: { type: string; name?: string };
    property?: { type: string; name?: string; value?: unknown };
    computed?: boolean;
  };
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    if (
      node.object?.type === "Identifier" &&
      WORKER_GLOBALS.has(node.object.name ?? "")
    ) {
      if (!node.computed && node.property?.type === "Identifier") {
        return node.property.name;
      }
      if (node.computed && node.property?.type === "Literal") {
        const value = (node.property as unknown as { value?: unknown }).value;
        if (typeof value === "string") return value;
      }
    }
  }
  return undefined;
};

const scanScriptSecurity = (source: string, path: string): void => {
  let program: AcornNode;
  try {
    program = parseScript(source, { ecmaVersion: "latest" });
  } catch {
    // 产物 JS 必须可解析；解析失败本身即为门禁违规。
    throw new Error(`distributed script is not parseable: ${path}`);
  }

  const visit = (node: AcornNode): void => {
    const candidate = node as unknown as { type: string };
    if (candidate.type === "Literal" || candidate.type === "TemplateLiteral") {
      let offending: string | undefined;
      if (candidate.type === "Literal") {
        const value = (node as unknown as { value?: unknown }).value;
        if (typeof value === "string" && isExternalScriptUrl(value)) offending = value;
      } else {
        offending = templateIsExternal(node);
      }
      if (offending !== undefined) {
        throw new Error(`external runtime dependency found in ${path}: ${offending}`);
      }
    }
    if (candidate.type === "NewExpression") {
      const callee = (node as unknown as { callee?: AcornNode }).callee;
      const constructorName = callee ? calleeConstructorName(callee) : undefined;
      if (constructorName !== undefined && WORKER_CONSTRUCTORS.has(constructorName)) {
        throw new Error(`worker constructor found in ${path}: ${constructorName}`);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            visit(item as AcornNode);
          }
        }
      } else if (child && typeof child === "object" && "type" in child) {
        visit(child as AcornNode);
      }
    }
  };
  visit(program);

  // AST 覆盖不了的兜底：内联事件处理属性（字符串形态）与 service worker 注册。
  if (/serviceWorker\s*\.\s*register\s*\(/i.test(source)) {
    throw new Error(`service worker registration found in ${path}`);
  }
  if (/\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(source)) {
    throw new Error(`inline event handler attribute found in ${path}`);
  }
};

const scanStyleSecurity = (source: string, path: string): void => {
  // CSS 中的 URL 同样按 WHATWG 规范化后判断：内部 TAB/LF/CR 与首尾
  // C0/space 都不能掩盖外部 scheme。
  const normalizedSource = normalizeUrlValue(source).replace(/[\t\n\r]/g, "");
  if (/@import\s+(?:url\()?\s*(["']?)(?:https?:)?\/\//i.test(normalizedSource)) {
    throw new Error(`external runtime dependency found in ${path}`);
  }
  if (/url\s*\(\s*(["']?)(?:https?:)?\/\//i.test(normalizedSource)) {
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
