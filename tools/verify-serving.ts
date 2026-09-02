import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface VerifyServingOptions {
  readonly servingConfigPath: string;
}

const requiredSecurityHeaders: readonly {
  readonly name: string;
  readonly value: string;
}[] = [
  {
    name: "Content-Security-Policy",
    value:
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; worker-src 'none'; base-uri 'none'",
  },
  { name: "X-Content-Type-Options", value: "nosniff" },
  { name: "Referrer-Policy", value: "no-referrer" },
  { name: "X-Frame-Options", value: "DENY" },
  {
    name: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

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

export const verifyServing = async ({
  servingConfigPath,
}: VerifyServingOptions): Promise<void> => {
  const config = await readFile(servingConfigPath, "utf8");

  if (!/^\s*listen 8080;$/m.test(config)) {
    throw new Error("serving config must listen on the unprivileged 8080 port");
  }
  if (/^\s*listen\s+80\s*;/m.test(config)) {
    throw new Error("serving config must not listen on port 80 as the container");
  }
  if (/\buser\s+root\b/i.test(config)) {
    throw new Error("serving config must not run as root");
  }

  for (const { name, value } of requiredSecurityHeaders) {
    const pattern = new RegExp(
      `add_header ${name} "${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" always;`,
    );
    if (!pattern.test(config)) {
      throw new Error(`missing or altered security header: ${name}`);
    }
  }
  if (/add_header\s+Strict-Transport-Security/i.test(config)) {
    throw new Error("serving config must not send HSTS during the HTTP phase");
  }
  if (/(?:add_header|proxy_redirect|return\s+30\d)\s+[^;]*https:/i.test(config)) {
    throw new Error("serving config must not redirect to HTTPS");
  }

  const headerNames = new Set(
    [...config.matchAll(/^\s*add_header\s+([A-Za-z-]+)\s/gm)].map((match) => match[1]),
  );
  const unexpected = [...headerNames].filter(
    (name) =>
      !requiredSecurityHeaders.some((header) => header.name === name) &&
      name !== "Cache-Control",
  );
  if (unexpected.length > 0) {
    throw new Error(`unexpected response headers declared: ${unexpected.join(", ")}`);
  }

  for (const path of revalidatePaths) {
    const block = extractBlock(config, path);
    if (!block.includes('add_header Cache-Control "no-cache, must-revalidate" always;')) {
      throw new Error(`path must be served with revalidation: ${path}`);
    }
    if (/max-age=\d{4,}/.test(block)) {
      throw new Error(`revalidated path must not gain a long freshness window: ${path}`);
    }
  }
  for (const path of immutablePaths) {
    const block = extractBlock(config, path);
    if (
      !block.includes(
        'add_header Cache-Control "public, max-age=31536000, immutable" always;',
      )
    ) {
      throw new Error(`content-addressed path must be cached immutably: ${path}`);
    }
  }

  const locations = [...config.matchAll(/^\s*location[^\{]*\{/gm)].map((m) =>
    m[0].trim(),
  );
  const knownLocations = [...revalidatePaths, ...immutablePaths];
  for (const location of locations) {
    if (!knownLocations.includes(location)) {
      throw new Error(`undeclared location block in serving config: ${location}`);
    }
  }
  if (locations.length !== knownLocations.length) {
    throw new Error("serving config must declare exactly the governed location set");
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await verifyServing({
    servingConfigPath: join(process.cwd(), "deploy", "nginx-serving.conf"),
  });
  console.log("Verified serving security headers and cache policy baseline");
}
