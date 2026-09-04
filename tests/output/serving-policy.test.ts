import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyServing } from "../../tools/verify-serving";

const projectRoot = process.cwd();
const servingConfigPath = join(projectRoot, "deploy", "nginx-serving.conf");
const securityHeadersPath = join(projectRoot, "deploy", "security-headers.conf");

// 记录本测试文件创建的全部临时目录；teardown 统一回收，清理失败不得静默。
const createdTempRoots: string[] = [];

const tampered = async (
  mutate: (config: string) => string,
  mutateHeaders?: (headers: string) => string,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "devhot-serving-"));
  createdTempRoots.push(root);
  const configDir = join(root, "deploy");
  await cp(dirname(securityHeadersPath), configDir, { recursive: true });
  const path = join(configDir, "nginx-serving.conf");
  const original = await readFile(path, "utf8");
  await writeFile(path, mutate(original));
  if (mutateHeaders) {
    const headers = await readFile(securityHeadersPath, "utf8");
    await writeFile(join(configDir, "security-headers.conf"), mutateHeaders(headers));
  }
  return path;
};

// 无论测试成功、断言失败或构建失败，都回收本次创建的精确目录（不按全局
// 前缀删除历史目录）；清理失败原样抛出。
afterEach(async () => {
  const failures: Error[] = [];
  while (createdTempRoots.length > 0) {
    const root = createdTempRoots.pop()!;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "serving-policy temp cleanup failed");
  }
});

describe("serving security and cache policy", () => {
  it("accepts the committed serving baseline", async () => {
    await expect(verifyServing({ servingConfigPath })).resolves.toBeUndefined();
  });

  it.each([
    [
      "drops the include snippet from one cache location (add_header inheritance)",
      (config: string) =>
        config.replace(
          /location = \/release\.json \{\n        include deploy\/security-headers\.conf;\n/,
          "location = /release.json {\n",
        ),
    ],
    [
      "drops the server-level fallback include",
      (config: string) =>
        config.replace(
          "    # server 层兜底：未命中任何 location 的响应（如 404）也带全部安全头。\n    include deploy/security-headers.conf;\n",
          "",
        ),
    ],
    [
      "declares a security header directly in the serving config",
      (config: string) =>
        config.replace(
          "listen 8080;",
          'listen 8080;\n    add_header X-Content-Type-Options "nosniff" always;',
        ),
    ],
    [
      "weakens the CSP with an unsafe-inline exception",
      (config: string) => config,
      (headers: string) =>
        headers.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
    ],
    [
      "adds a third-party origin to the CSP",
      (config: string) => config,
      (headers: string) =>
        headers.replace("img-src 'self' data:;", "img-src 'self' https:;"),
    ],
    [
      "sends HSTS during the HTTP phase",
      (config: string) =>
        config.replace(
          "listen 8080;",
          'listen 8080;\n    add_header Strict-Transport-Security "max-age=31536000" always;',
        ),
    ],
    [
      "redirects to HTTPS",
      (config: string) =>
        config.replace(
          "listen 8080;",
          "listen 8080;\n    return 301 https://$host$request_uri;",
        ),
    ],
    [
      "caches HTML with a long freshness window",
      (config: string) =>
        config.replace(
          'add_header Cache-Control "no-cache, must-revalidate" always;\n        try_files',
          'add_header Cache-Control "public, max-age=31536000" always;\n        try_files',
        ),
    ],
    [
      "drops the immutable marker from content-addressed assets",
      (config: string) =>
        config.replace(
          'location /media/sha256/ {\n        include deploy/security-headers.conf;\n        add_header Cache-Control "public, max-age=31536000, immutable" always;',
          'location /media/sha256/ {\n        include deploy/security-headers.conf;\n        add_header Cache-Control "public, max-age=31536000" always;',
        ),
    ],
    [
      "listens on privileged port 80 inside the container",
      (config: string) => config.replace("listen 8080;", "listen 80;"),
    ],
  ])(
    "rejects a serving config that %s",
    async (
      _reason: string,
      mutate: (config: string) => string,
      mutateHeaders?: (headers: string) => string,
    ) => {
      const path = await tampered(mutate, mutateHeaders);
      await expect(verifyServing({ servingConfigPath: path })).rejects.toThrow();
    },
  );
});
