import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyServing } from "../../tools/verify-serving";

const projectRoot = process.cwd();
const servingConfigPath = join(projectRoot, "deploy", "nginx-serving.conf");

const tampered = async (mutate: (config: string) => string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "devhot-serving-"));
  const original = await readFile(servingConfigPath, "utf8");
  const path = join(root, "nginx-serving.conf");
  await writeFile(path, mutate(original));
  return path;
};

describe("serving security and cache policy", () => {
  it("accepts the committed serving baseline", async () => {
    await expect(verifyServing({ servingConfigPath })).resolves.toBeUndefined();
  });

  it.each([
    [
      "drops the CSP header",
      (config: string) =>
        config.replace(/add_header Content-Security-Policy[^;]+;[^\n]*\n/, ""),
    ],
    [
      "weakens the CSP with an unsafe-inline exception",
      (config: string) =>
        config.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
    ],
    [
      "adds a third-party origin to the CSP",
      (config: string) =>
        config.replace("img-src 'self' data:;", "img-src 'self' https:;"),
    ],
    [
      "sends HSTS during the HTTP phase",
      (config: string) =>
        config.replace(
          'add_header X-Content-Type-Options "nosniff" always;',
          'add_header X-Content-Type-Options "nosniff" always;\n    add_header Strict-Transport-Security "max-age=31536000" always;',
        ),
    ],
    [
      "redirects to HTTPS",
      (config: string) =>
        config.replace(
          'add_header X-Content-Type-Options "nosniff" always;',
          'add_header X-Content-Type-Options "nosniff" always;\n    return 301 https://$host$request_uri;',
        ),
    ],
    [
      "caches HTML with a long freshness window",
      (config: string) =>
        config.replace(
          'location / {\n        try_files $uri $uri/ =404;\n        add_header Cache-Control "no-cache, must-revalidate" always;',
          'location / {\n        try_files $uri $uri/ =404;\n        add_header Cache-Control "public, max-age=31536000" always;',
        ),
    ],
    [
      "drops the immutable marker from content-addressed assets",
      (config: string) =>
        config.replace(
          'location /media/sha256/ {\n        add_header Cache-Control "public, max-age=31536000, immutable" always;',
          'location /media/sha256/ {\n        add_header Cache-Control "public, max-age=31536000" always;',
        ),
    ],
    [
      "listens on privileged port 80 inside the container",
      (config: string) => config.replace("listen 8080;", "listen 80;"),
    ],
  ])("rejects a serving config that %s", async (_reason, mutate) => {
    const path = await tampered(mutate);
    await expect(verifyServing({ servingConfigPath: path })).rejects.toThrow();
  });
});
