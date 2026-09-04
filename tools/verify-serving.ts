import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface VerifyServingOptions {
  readonly servingConfigPath: string;
}

export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; worker-src 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

const revalidatePaths: readonly string[] = [
  "location / {",
  "location = /release.json {",
  "location = /_publication.json {",
  "location /maintenance/ {",
  "location /timeline/fragments/ {",
];

const immutablePaths: readonly string[] = [
  "location /media/sha256/ {",
  "location /_astro/ {",
];

const extractBlock = (config: string, header: string): string => {
  const start = config.indexOf(header);
  if (start < 0) return "";
  const open = config.indexOf("{", start);
  const close = config.indexOf("}", open);
  if (open < 0 || close < 0) return "";
  return config.slice(open + 1, close);
};

const headerLine = (name: string, value: string): string =>
  `add_header ${name} "${value}" always;`;

export const verifyServing = async ({
  servingConfigPath,
}: VerifyServingOptions): Promise<void> => {
  const configPath = resolve(servingConfigPath);
  const config = await readFile(configPath, "utf8");
  const headersPath = join(dirname(configPath), "security-headers.conf");
  const headersConfig = await readFile(headersPath, "utf8");

  if (!/^\s*listen 8080;\s*$/m.test(config)) {
    throw new Error("serving config must listen on the unprivileged 8080 port");
  }
  if (/^\s*listen\s+80\s*;/m.test(config)) {
    throw new Error("serving config must not listen on port 80 as the container");
  }
  if (/\buser\s+root\b/i.test(config)) {
    throw new Error("serving config must not run as root");
  }

  // 安全头集中在 security-headers.conf；serving config 中除 Cache-Control 外
  // 不得再出现任何 add_header（安全头只能经 include 片段进入）。
  for (const [name, value] of Object.entries(securityHeaders)) {
    const line = headerLine(name, value);
    if (!headersConfig.includes(line)) {
      throw new Error(`missing or altered security header: ${name}`);
    }
  }
  const strayHeaderPattern = /^\s*add_header\s+(?!Cache-Control)/gm;
  for (const match of config.matchAll(strayHeaderPattern)) {
    throw new Error(
      `serving config must declare security headers only via the snippet: ${match[0].trim()}`,
    );
  }
  const snippetHeaderCount = headersConfig.match(/^\s*add_header\s+/gm)?.length ?? 0;
  if (snippetHeaderCount !== Object.keys(securityHeaders).length) {
    throw new Error("security headers snippet must declare exactly the governed headers");
  }

  for (const source of [config, headersConfig]) {
    if (/add_header\s+Strict-Transport-Security/i.test(source)) {
      throw new Error("serving config must not send HSTS during the HTTP phase");
    }
    if (/(?:add_header|proxy_redirect|return\s+30\d)\s+[^;]*https:/i.test(source)) {
      throw new Error("serving config must not redirect to HTTPS");
    }
  }

  // add_header 继承规则：每个声明 Cache-Control 的 location 都必须重复
  // include security-headers.conf，否则该 location 响应会丢失安全头。
  const snippetInclude = "include deploy/security-headers.conf;";
  if (!config.includes(snippetInclude)) {
    throw new Error("serving config must include the security headers snippet");
  }
  // server 层兜底 include 必须存在且位于所有 location 之前（覆盖 404 等未命中路径）。
  const serverIncludeCount =
    config.match(/^\s{4}include deploy\/security-headers\.conf;$/m)?.length ?? 0;
  const firstLocationIndex = config.search(/^\s*location/m);
  const serverIncludeIndex = config.search(
    /^\s{4}include deploy\/security-headers\.conf;$/m,
  );
  if (
    serverIncludeCount < 1 ||
    serverIncludeIndex < 0 ||
    serverIncludeIndex > firstLocationIndex
  ) {
    throw new Error(
      "serving config must include the security headers snippet at server level before any location",
    );
  }
  // 命名 location（@name）不属于缓存 location 集合，单独校验。
  const cacheLocations = [...config.matchAll(/^\s*location[^\{@]*\{/gm)].map((m) =>
    m[0].trim(),
  );
  const knownLocations = [...revalidatePaths, ...immutablePaths];
  if (cacheLocations.length !== knownLocations.length) {
    throw new Error("serving config must declare exactly the governed location set");
  }
  for (const location of cacheLocations) {
    if (!knownLocations.includes(location)) {
      throw new Error(`undeclared location block in serving config: ${location}`);
    }
    const block = extractBlock(config, location);
    if (!block.includes(snippetInclude)) {
      throw new Error(
        `location must re-include the security headers snippet: ${location}`,
      );
    }
    if (revalidatePaths.includes(location)) {
      if (
        !block.includes('add_header Cache-Control "no-cache, must-revalidate" always;')
      ) {
        throw new Error(`path must be served with revalidation: ${location}`);
      }
      if (/max-age=\d{4,}/.test(block)) {
        throw new Error(
          `revalidated path must not gain a long freshness window: ${location}`,
        );
      }
    } else {
      if (
        !block.includes(
          'add_header Cache-Control "public, max-age=31536000, immutable" always;',
        )
      ) {
        throw new Error(`content-addressed path must be cached immutably: ${location}`);
      }
      // 哈希资源路径必须显式 try_files ... =404，缺失文件进入 404 处理，
      // 不得把 immutable 缓存套在 404 响应上。
      if (!/try_files\s+\$uri\s+=404;/.test(block)) {
        throw new Error(
          `content-addressed path must fail closed to 404 for missing assets: ${location}`,
        );
      }
    }
  }

  // 哈希资源 404 必须重验证并保留全部安全头：error_page 指向命名 location，
  // 该 location 重复 include 安全头片段并声明 no-cache。
  const hashedMissingBlock = extractBlock(config, "location @hashed_missing {");
  if (!hashedMissingBlock) {
    throw new Error(
      "serving config must route hashed-asset 404s to @hashed_missing for revalidation",
    );
  }
  if (!/error_page\s+404\s+@hashed_missing;/.test(config)) {
    throw new Error("serving config must declare error_page 404 @hashed_missing");
  }
  if (!hashedMissingBlock.includes(snippetInclude)) {
    throw new Error("@hashed_missing must re-include the security headers snippet");
  }
  if (
    !hashedMissingBlock.includes(
      'add_header Cache-Control "no-cache, must-revalidate" always;',
    )
  ) {
    throw new Error("@hashed_missing must serve 404s with revalidation");
  }
  if (/max-age=\d{4,}/.test(hashedMissingBlock)) {
    throw new Error("@hashed_missing must not gain a long freshness window");
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await verifyServing({
    servingConfigPath: join(process.cwd(), "deploy", "nginx-serving.conf"),
  });
  console.log("Verified serving security headers and cache policy baseline");
}
