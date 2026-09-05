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
      // 哈希资源路径不得声明 try_files $uri =404：它会把“存在但不可读”
      // 的 403 强转成 404。缺失与不可读由静态模块按真实状态返回，并统一
      // 经 error_page 分流到 @hashed_error（重验证）。
      if (/try_files/.test(block)) {
        throw new Error(
          `content-addressed path must let the static module surface the true status: ${location}`,
        );
      }
    }
  }

  // 哈希资源错误响应的缓存策略按请求/响应形态决定，不允许单一状态特例：
  // - 404/403 经 error_page 内部重定向到 @hashed_error：重验证 + 安全头；
  // - 416 无法在原始 location 之外剥离已应用的 immutable，改由
  //   map($http_range) 在源头对一切带 Range 的请求（206/416）使用重验证。
  const hashedErrorBlock = extractBlock(config, "location @hashed_error {");
  if (!hashedErrorBlock) {
    throw new Error(
      "serving config must route hashed-asset 404/403 to @hashed_error for revalidation",
    );
  }
  // error_page 必须覆盖全部 4xx/5xx（不得逐一枚举本轮发现的错误码），
  // 且不得包含 3xx（304 等条件成功响应保持原语义）。
  const errorPageMatch = config.match(/error_page\s+([\d\s]+)@hashed_error;/);
  if (!errorPageMatch) {
    throw new Error(
      "serving config must map hashed-asset errors to @hashed_error for revalidation",
    );
  }
  const mappedStatuses = (errorPageMatch[1] ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(Number)
    .filter((code) => Number.isInteger(code) && code > 0);
  const forbidden = mappedStatuses.filter((code) => code < 400);
  if (forbidden.length > 0) {
    throw new Error(
      `error_page must not intercept success/redirect statuses: ${forbidden.join(",")}`,
    );
  }
  for (const required of [400, 401, 403, 404, 405, 412, 413, 415, 416, 429, 500, 503]) {
    if (!mappedStatuses.includes(required)) {
      throw new Error(
        `error_page must cover the full 4xx/5xx error space (missing ${required})`,
      );
    }
  }
  const allClientErrors = [
    400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416,
    417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  ];
  const missing = allClientErrors.filter((code) => !mappedStatuses.includes(code));
  if (missing.length > 0) {
    throw new Error(
      `error_page must cover every 4xx client error (missing ${missing.join(",")})`,
    );
  }
  if (!hashedErrorBlock.includes(snippetInclude)) {
    throw new Error("@hashed_error must re-include the security headers snippet");
  }
  if (
    !hashedErrorBlock.includes(
      'add_header Cache-Control "no-cache, must-revalidate" always;',
    )
  ) {
    throw new Error("@hashed_error must serve error responses with revalidation");
  }
  if (/max-age=\d{4,}/.test(hashedErrorBlock)) {
    throw new Error("@hashed_error must not gain a long freshness window");
  }
  // Range 请求一律重验证（覆盖 416 越界与 206 部分内容）。
  const rangeMapBlock = extractBlock(config, "map $http_range $hashed_cache_control {");
  if (!rangeMapBlock) {
    throw new Error("serving config must map hashed cache policy on $http_range");
  }
  if (
    !rangeMapBlock.includes('default            "public, max-age=31536000, immutable";')
  ) {
    throw new Error("hashed-asset plain responses must be immutable");
  }
  if (!rangeMapBlock.includes('~.+                "no-cache, must-revalidate";')) {
    throw new Error("hashed-asset Range requests must use revalidation");
  }
  // 哈希路径必须引用映射变量（不得写死 immutable 字面量）。
  for (const path of immutablePaths) {
    const block = extractBlock(config, path);
    if (!block.includes("add_header Cache-Control $hashed_cache_control always;")) {
      throw new Error(
        `content-addressed path must derive cache policy from the range map: ${path}`,
      );
    }
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await verifyServing({
    servingConfigPath: join(process.cwd(), "deploy", "nginx-serving.conf"),
  });
  console.log("Verified serving security headers and cache policy baseline");
}
