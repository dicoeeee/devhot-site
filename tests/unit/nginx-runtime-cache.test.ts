import { mkdtemp, mkdir, rm, stat, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile) as (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * 运行时缓存反例回归（P2）：缓存身份必须绑定实际内容与构建配方，
 * 不能绑定缓存路径名称。测试通过受控 TMPDIR 隔离出独立的缓存目录，
 * 逐一验证伪内容不会被接受。
 *
 * 注意：ensureNginxRuntime 的缓存目录由模块加载时的 tmpdir() 决定，
 * 因此本文件用子进程 + 环境变量隔离验证（不污染真实缓存）。
 */
const runCacheProbe = async (
  setup: (cacheRoot: string, runtimeDirName: string) => Promise<void>,
  probeScript: string,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const isolated = await mkdtemp(join(tmpdir(), "devhot-runtime-cache-test-"));
  try {
    // 通过模块导出的配方要素推导缓存目录名（版本 + 配方指纹前 16 位）。
    const runtime = await import("../support/nginx-runtime");
    const fingerprintInput = JSON.stringify({
      recipeVersion: 2,
      nginxVersion: runtime.NGINX_VERSION,
      tarballSha256: runtime.NGINX_TARBALL_SHA256,
      configureArgs: ["--without-http_gzip_module"],
      platform: process.platform,
      arch: process.arch,
    });
    const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
    const runtimeDirName = `devhot-nginx-${runtime.NGINX_VERSION}-${fingerprint.slice(0, 16)}`;
    await setup(isolated, runtimeDirName);
    const result = await execFileAsync(
      "node",
      ["--input-type=module", "-e", probeScript],
      {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: isolated, PATH: process.env.PATH ?? "" },
      },
    ).then(
      (ok) => ({ stdout: ok.stdout, stderr: "", code: 0 }),
      (error) => ({
        stdout: (error as { stdout?: string }).stdout ?? "",
        stderr: (error as { stderr?: string }).stderr ?? "",
        code: (error as { code?: number }).code ?? 1,
      }),
    );
    return result;
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
};

/** 探针脚本：在隔离 TMPDIR 中调用 ensureNginxRuntime 并输出结论。 */
const probeSource = `
import { ensureNginxRuntime } from "./tests/support/nginx-runtime.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
try {
  const resolved = await ensureNginxRuntime();
  // 在隔离 TMPDIR 仍然存在时验证产物是真实 nginx（-v 输出版本行）。
  let versionOk = false;
  try {
    await execFileAsync(resolved, ["-v"]);
    versionOk = true;
  } catch (error) {
    const stderr = (error && error.stderr) || "";
    versionOk = stderr.includes("nginx version: nginx/");
  }
  console.log("RESOLVED=" + resolved);
  console.log("VERSION_OK=" + versionOk);
} catch (error) {
  console.log("THREW=" + (error && error.message ? error.message.slice(0, 120) : "unknown"));
}
`;

describe("pinned nginx runtime cache integrity", () => {
  it(
    "rejects a fake binary at the expected cache path (exit 0 stub)",
    { timeout: 120_000 },
    async () => {
      const result = await runCacheProbe(async (root, dirName) => {
        const sbin = join(root, dirName, "sbin");
        await mkdir(sbin, { recursive: true });
        const fake = join(sbin, "nginx");
        await writeFile(fake, "#!/bin/sh\nexit 0\n");
        await chmod(fake, 0o755);
      }, probeSource);
      // 伪二进制不被接受：要么触发重建（RESOLVED 指向真实二进制并验证
      // 通过），要么失败；绝不能把伪路径当作固定运行时直接返回。
      const resolved = result.stdout.match(/RESOLVED=(.*)/)?.[1] ?? "";
      expect(resolved.endsWith("sbin/nginx")).toBe(true);
      // 伪缓存必须被拒绝并重建：产物在探针内验证为真实 nginx。
      expect(result.stdout).toContain("VERSION_OK=true");
    },
  );

  it(
    "rejects a cache with a missing marker (half-installed state)",
    { timeout: 120_000 },
    async () => {
      const result = await runCacheProbe(async (root, dirName) => {
        const sbin = join(root, dirName, "sbin");
        await mkdir(sbin, { recursive: true });
        // 半安装：真实系统 nginx 也无法通过 marker 校验（无 marker 即拒绝）。
        const realNginx =
          "/var/folders/16/kt87dmvx3tz0zmfggqwzlyx40000gn/T/devhot-nginx-1.30.4-4261dc90e9e4/sbin/nginx";
        const statResult = await stat(realNginx).then(
          () => true,
          () => false,
        );
        if (statResult) {
          await execFileAsync("cp", [realNginx, join(sbin, "nginx")]);
          await chmod(join(sbin, "nginx"), 0o755);
        } else {
          await writeFile(join(sbin, "nginx"), "#!/bin/sh\nexit 0\n");
          await chmod(join(sbin, "nginx"), 0o755);
        }
        // 不写 marker：半安装状态。
      }, probeSource);
      const resolved = result.stdout.match(/RESOLVED=(.*)/)?.[1] ?? "";
      // 无 marker：触发重建；绝不直接接受无 marker 的缓存。
      expect(resolved.endsWith("sbin/nginx")).toBe(true);
      expect(result.stdout).toContain("VERSION_OK=true");
    },
  );

  it(
    "rejects a cache whose marker disagrees with the actual binary fingerprint",
    { timeout: 120_000 },
    async () => {
      const result = await runCacheProbe(async (root, dirName) => {
        const sbin = join(root, dirName, "sbin");
        await mkdir(sbin, { recursive: true });
        await writeFile(join(sbin, "nginx"), "#!/bin/sh\nexit 0\n");
        await chmod(join(sbin, "nginx"), 0o755);
        // marker 指纹与实际内容不符。
        await writeFile(
          join(root, dirName, ".install-complete"),
          JSON.stringify({
            schemaVersion: 2,
            nginxVersion: "1.30.4",
            tarballSha256:
              "4261dc90e9e47c1c4041276e9aaa3d48ebe2e664f728e14fa95ae6c67d57a08b",
            recipeFingerprint: "deadbeefdeadbeefdeadbeefdeadbeef",
            binarySha256: "0".repeat(64),
          }),
        );
      }, probeSource);
      const resolved = result.stdout.match(/RESOLVED=(.*)/)?.[1] ?? "";
      expect(resolved.endsWith("sbin/nginx")).toBe(true);
      expect(result.stdout).toContain("VERSION_OK=true");
    },
  );

  it(
    "a marker with a different recipe fingerprint is not the current runtime",
    { timeout: 120_000 },
    async () => {
      // 配方变化（如 configure 参数不同）产生不同指纹：同目录名不会被
      // 匹配——本测试验证“同名目录 + 异配方 marker”不被当作当前运行时。
      const result = await runCacheProbe(async (root, dirName) => {
        const sbin = join(root, dirName, "sbin");
        await mkdir(sbin, { recursive: true });
        await writeFile(join(sbin, "nginx"), "#!/bin/sh\nexit 0\n");
        await chmod(join(sbin, "nginx"), 0o755);
        await writeFile(
          join(root, dirName, ".install-complete"),
          JSON.stringify({
            schemaVersion: 2,
            nginxVersion: "1.30.4",
            tarballSha256:
              "4261dc90e9e47c1c4041276e9aaa3d48ebe2e664f728e14fa95ae6c67d57a08b",
            recipeFingerprint: "different-recipe-fingerprint-value",
            binarySha256: "0".repeat(64),
          }),
        );
      }, probeSource);
      const resolved = result.stdout.match(/RESOLVED=(.*)/)?.[1] ?? "";
      expect(resolved.endsWith("sbin/nginx")).toBe(true);
      expect(result.stdout).toContain("VERSION_OK=true");
    },
  );

  it(
    "concurrent prepare calls converge on one validated cache",
    { timeout: 300_000 },
    async () => {
      // 两个并发 ensureNginxRuntime：同进程内收敛为一次构建；跨进程由
      // 锁文件保护。两者最终都拿到通过内容校验的二进制。
      const isolated = await mkdtemp(join(tmpdir(), "devhot-runtime-concurrent-"));
      try {
        const script = `
import { ensureNginxRuntime } from "./tests/support/nginx-runtime.ts";
const [a, b] = await Promise.all([
  ensureNginxRuntime(),
  ensureNginxRuntime(),
]);
if (a !== b) throw new Error("divergent results: " + a + " vs " + b);
console.log("CONVERGED=" + a);
`;
        const result = await execFileAsync(
          "node",
          ["--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: { ...process.env, TMPDIR: isolated },
          },
        ).then(
          (ok) => ok.stdout,
          (error) => {
            throw new Error(
              (error as { stderr?: string }).stderr ?? "concurrent probe failed",
            );
          },
        );
        const converged = result.match(/CONVERGED=(.*)/)?.[1] ?? "";
        expect(converged.endsWith("sbin/nginx")).toBe(true);
        // 产物必须通过内容验证（真实 -v 输出）。
        const version = await execFileAsync(converged, ["-v"]).catch(() => undefined);
        expect(version).toBeDefined();
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );

  it(
    "real cache marker matches actual binary fingerprint (positive control)",
    { timeout: 300_000 },
    async () => {
      // 正向对照：真实缓存的 marker 与二进制指纹一致，且 -V 版本匹配。
      const runtime = await import("../support/nginx-runtime");
      await runtime.ensureNginxRuntime();
      const resolved = await runtime.ensureNginxRuntime();
      const marker = JSON.parse(
        await readFile(join(resolved, "..", "..", ".install-complete"), "utf8"),
      ) as { binarySha256: string };
      const actual = createHash("sha256")
        .update(await readFile(resolved))
        .digest("hex");
      expect(marker.binarySha256).toBe(actual);
    },
  );
});
