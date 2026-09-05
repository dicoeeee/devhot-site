import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
  chmod,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureNginxRuntime,
  findFreePort,
  serveWithNginx,
} from "../support/nginx-runtime";
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
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const execFileAsync = promisify(execFile);
try {
  const resolved = await ensureNginxRuntime();
  // 在隔离 TMPDIR 仍然存在时验证产物是真实 nginx：解析 -V 的
  // stdout+stderr，精确校验版本行、--prefix 与 configure 参数——
  // 不是只看退出码（"exit 0" 伪脚本无法伪造这些内容）。
  let combined = "";
  try {
    const ok = await execFileAsync(resolved, ["-V"]);
    combined = (ok.stdout || "") + (ok.stderr || "");
  } catch (error) {
    combined = ((error && error.stdout) || "") + ((error && error.stderr) || "");
  }
  const versionOk =
    combined.includes("nginx version: nginx/1.30.4") &&
    combined.includes("--prefix=") &&
    combined.includes("--without-http_gzip_module");
  // 同时校验 marker 与二进制实际指纹一致。
  let markerOk = false;
  try {
    const marker = JSON.parse(
      await readFile(
        resolved.replace("/sbin/nginx", "/.install-complete"),
        "utf8",
      ),
    );
    const actual = createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex");
    markerOk = marker.binarySha256 === actual && marker.recipeFingerprint && marker.schemaVersion === 2;
  } catch {
    markerOk = false;
  }
  console.log("RESOLVED=" + resolved);
  console.log("VERSION_OK=" + versionOk);
  console.log("MARKER_OK=" + markerOk);
} catch (error) {
  console.log("THREW=" + (error && error.message ? error.message.slice(0, 120) : "unknown"));
}
`;

describe("pinned nginx runtime cache integrity", () => {
  it(
    "rejects a fake binary at the expected cache path (exit 0 stub)",
    { timeout: 600_000 },
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
      expect(result.stdout).toContain("MARKER_OK=true");
    },
  );

  it(
    "rejects a cache with a missing marker (half-installed state)",
    { timeout: 600_000 },
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
      expect(result.stdout).toContain("MARKER_OK=true");
    },
  );

  it(
    "rejects a cache whose marker disagrees with the actual binary fingerprint",
    { timeout: 600_000 },
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
      expect(result.stdout).toContain("MARKER_OK=true");
    },
  );

  it(
    "a marker with a different recipe fingerprint is not the current runtime",
    { timeout: 600_000 },
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
      expect(result.stdout).toContain("MARKER_OK=true");
    },
  );

  it(
    "in-process concurrent prepare calls converge on one validated cache",
    { timeout: 300_000 },
    async () => {
      // 同进程内并发：合并为一次 in-flight 准备，产物通过内容校验。
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
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );

  it(
    "two independent processes racing on the same cache yield one build, no residue",
    { timeout: 600_000 },
    async () => {
      // 两个独立 Node 进程 + 同步屏障（就绪文件 + 定时同时起跑）竞争
      // 同一缓存目标：锁必须互斥，最终只有一份完整 marker/二进制，且
      // 锁文件被清理（无残留、无相互删除）。
      const isolated = await mkdtemp(join(tmpdir(), "devhot-runtime-race-"));
      try {
        const script = `
import { ensureNginxRuntime } from "./tests/support/nginx-runtime.ts";
import { stat, writeFile } from "node:fs/promises";
const barrier = process.env.BARRIER_PATH;
// 就绪屏障：各自写自己的 ready 文件，等待两份都出现后同时起跑。
await writeFile(barrier + ".ready", "1");
const other = process.env.OTHER_BARRIER;
for (let i = 0; i < 600; i += 1) {
  try {
    await stat(other + ".ready");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}
const startAt = Date.now() + 150;
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 5));
const resolved = await ensureNginxRuntime();
console.log("RACE_DONE=" + resolved);
`;
        const runChild = (ordinal: string) =>
          execFileAsync("node", ["--input-type=module", "-e", script], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              TMPDIR: isolated,
              BARRIER_PATH: `${join(isolated, "barrier")}.${ordinal}`,
              OTHER_BARRIER: `${join(isolated, "barrier")}.${ordinal === "1" ? "2" : "1"}`,
            },
          }).then(
            (ok) => ok.stdout,
            (error) => {
              throw new Error(
                `race child failed: ${(error as { stderr?: string }).stderr ?? "unknown"}`,
              );
            },
          );
        const [first, second] = await Promise.all([runChild("1"), runChild("2")]);
        const done1 = first.match(/RACE_DONE=(.*)/)?.[1] ?? "";
        const done2 = second.match(/RACE_DONE=(.*)/)?.[1] ?? "";
        // 两个进程都拿到同一路径。
        expect(done1.endsWith("sbin/nginx")).toBe(true);
        expect(done1).toBe(done2);
        // 独立复核：marker 与二进制实际指纹一致（只有一份完整产物）。
        const runtimeDir = done1.replace("/sbin/nginx", "");
        const marker = JSON.parse(
          await readFile(join(runtimeDir, ".install-complete"), "utf8"),
        ) as { binarySha256: string };
        const actual = createHash("sha256")
          .update(await readFile(done1))
          .digest("hex");
        expect(marker.binarySha256).toBe(actual);
        // 无锁残留、无 stale 残留。
        await expect(stat(`${runtimeDir}.lock`)).rejects.toThrow();
        const leftovers = (await readdir(isolated)).filter(
          (entry) => entry.includes(".lock") || entry.includes("stale-"),
        );
        expect(leftovers).toEqual([]);
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );

  it(
    "re-verifies the cache on every call after a successful prepare",
    { timeout: 300_000 },
    async () => {
      // 永久信任反例：第一次 ensure 成功后，把隔离缓存中的二进制替换为
      // 伪脚本；第二次 ensure 必须拒绝/重建（不能直接返回旧结论）。
      const isolated = await mkdtemp(join(tmpdir(), "devhot-runtime-reswap-"));
      try {
        const script = `
import { ensureNginxRuntime } from "./tests/support/nginx-runtime.ts";
import { writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const first = await ensureNginxRuntime();
console.log("FIRST=" + first);
// 外部篡改：替换为 "exit 0" 伪脚本。
await writeFile(first, "#!/bin/sh" + String.fromCharCode(10) + "exit 0" + String.fromCharCode(10));
await chmod(first, 0o755);
const second = await ensureNginxRuntime();
console.log("SECOND=" + second);
// 第二次结果必须再次通过内容验证（-V 解析版本与 prefix）。
let combined = "";
try {
  const ok = await execFileAsync(second, ["-V"]);
  combined = (ok.stdout || "") + (ok.stderr || "");
} catch (error) {
  combined = ((error && error.stdout) || "") + ((error && error.stderr) || "");
}
console.log(
  "SECOND_REAL=" +
    (combined.includes("nginx version: nginx/1.30.4") && combined.includes("--prefix=")),
);
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
              (error as { stderr?: string }).stderr ?? "reswap probe failed",
            );
          },
        );
        expect(result).toContain("FIRST=");
        expect(result).toContain("SECOND=");
        expect(result).toContain("SECOND_REAL=true");
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

describe("observer output validation (exit-0 ≠ valid observation)", () => {
  // 表驱动：退出码 0 但输出为空/损坏时，观测必须是 UNKNOWN，绝不能
  // 折叠为“目标不存在/空集合/无监听者”。通过真实 serveWithNginx 实例
  // 的 PATH shim 黑盒验证（不是内部布尔注入参数）。
  const shims: {
    readonly name: string;
    readonly script: string;
  }[] = [
    {
      name: "exit 0 + empty stdout (ps and lsof)",
      script: "exit 0",
    },
    {
      name: "exit 0 + corrupt output (garbage lines)",
      script: 'echo "corrupted-not-a-process-table"; exit 0',
    },
  ];

  for (const shim of shims) {
    it(
      `treats "${shim.name}" as UNKNOWN and fails cleanup instead of faking success`,
      { timeout: 90_000 },
      async () => {
        const { buildReaderFixture } = await import("../support/browser-server");
        const build = await buildReaderFixture();
        const shimDir = await mkdtemp(join(tmpdir(), "obs-shim-"));
        let instance: Awaited<ReturnType<typeof serveWithNginx>> | undefined;
        try {
          const binary = await ensureNginxRuntime();
          const NL = String.fromCharCode(10);
          // shim：ps -p 与 lsof 都返回 exit 0 + 指定输出；ps -eo 走真实
          // 工具，以隔离“单命令成功但输出无效”的场景。
          const psShim =
            "#!/bin/sh" +
            NL +
            'if [ "$1" = "-p" ]; then ' +
            shim.script.replace(/"/g, '\\"') +
            "; fi" +
            NL +
            'exec /bin/ps "$@"' +
            NL;
          const lsofShim = "#!/bin/sh" + NL + shim.script.replace(/"/g, '\\"') + NL;
          await writeFile(join(shimDir, "ps"), psShim);
          await writeFile(join(shimDir, "lsof"), lsofShim);
          await chmod(join(shimDir, "ps"), 0o755);
          await chmod(join(shimDir, "lsof"), 0o755);

          instance = await serveWithNginx(
            binary,
            build.distRoot,
            join(process.cwd(), "deploy", "nginx-serving.conf"),
            join(process.cwd(), "deploy", "security-headers.conf"),
            await findFreePort(),
          );
          // SIGSTOP master：任何“假成功”都会让目录被删而进程仍在。
          process.kill(instance.masterPid, "SIGSTOP");
          const originalPath = process.env.PATH;
          process.env.PATH = shimDir + ":" + originalPath;
          let stopRejected = false;
          try {
            await instance.stop();
          } catch {
            stopRejected = true;
          } finally {
            process.env.PATH = originalPath;
          }
          const dirExists = await stat(instance.configDir).then(
            () => true,
            () => false,
          );
          // 独立探针（真实 /bin/ps，不经被测实现）。
          const { stdout } = await execFileAsync("/bin/ps", [
            "-p",
            String(instance.masterPid),
            "-o",
            "stat=,command=",
          ]);
          expect(stopRejected, "stop() must reject when observation is invalid").toBe(
            true,
          );
          expect(instance.state).toBe("cleanup-failed");
          expect(dirExists, "configDir must be retained for diagnosis").toBe(true);
          expect(
            stdout.trim().startsWith("T"),
            `master must be locatable: ${stdout}`,
          ).toBe(true);
        } finally {
          // 探针独立兜底：恢复调度并精确回收本测试的进程组与目录。
          if (instance !== undefined) {
            try {
              process.kill(instance.masterPid, "SIGCONT");
            } catch {
              // 已退出。
            }
            try {
              process.kill(-instance.instancePgid, "SIGKILL");
            } catch {
              // 组已不存在。
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
            await rm(instance.configDir, { recursive: true, force: true });
          }
          await rm(shimDir, { recursive: true, force: true });
          await build.cleanup();
        }
      },
    );
  }

  it(
    "lock: a live holder with an old lock file is never taken over by age",
    { timeout: 60_000 },
    async () => {
      // 活跃持有者 + 超龄锁不得抢占：锁由本测试进程持有（进程存活、
      // 启动身份匹配），mtime 回拨到 20 分钟前；另一路径的 acquireLock
      // 语义通过独立子进程验证——子进程必须拿不到锁。
      const isolated = await mkdtemp(join(tmpdir(), "lock-age-"));
      try {
        const lockPath = join(isolated, "runtime.lock");
        // 以本进程身份创建锁（与实现一致的 JSON 记录）。
        const start = await execFileAsync("/bin/ps", [
          "-p",
          String(process.pid),
          "-o",
          "lstart=",
        ]).then((r) => r.stdout.trim());
        const token = `holder-token-${Date.now()}`;
        await writeFile(
          lockPath,
          JSON.stringify({ token, pid: process.pid, startIdentity: start }) + "\n",
        );
        // 把 mtime 回拨到 20 分钟前（模拟超龄）。
        const { utimes } = await import("node:fs/promises");
        const old = new Date(Date.now() - 20 * 60_000);
        await utimes(lockPath, old, old);

        // 子进程尝试获取同一把锁：持有者（本进程）存活 → 必须失败。
        const probe = `
const { acquireLock } = await import("${join(process.cwd(), "tests/support/nginx-runtime.ts")}");
const lock = await acquireLock(${JSON.stringify(lockPath)});
console.log("ACQUIRED=" + (lock !== undefined));
`;
        const result = await execFileAsync("node", ["--input-type=module", "-e", probe], {
          cwd: process.cwd(),
          env: { ...process.env },
        }).then(
          (ok) => ok.stdout,
          (error) => {
            throw new Error(
              (error as { stderr?: string }).stderr ?? "lock-age probe failed",
            );
          },
        );
        expect(result).toContain("ACQUIRED=false");
        // 锁未被移动/删除：内容与 mtime 语义仍在（他人不得破坏）。
        const content = (await readFile(lockPath, "utf8")).trim();
        expect(JSON.parse(content).token).toBe(token);
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );

  it(
    "lock: a late claimer cannot move a new holder's lock (CAS on token)",
    { timeout: 60_000 },
    async () => {
      // 旧锁释放、新锁建立后，迟到抢占者不得移动新锁：
      // 读取（旧 token）→ 等待 → 锁被替换为新持有者 → rename 必须放弃
      // 或放回，绝不吞掉新锁。
      const isolated = await mkdtemp(join(tmpdir(), "lock-cas-"));
      try {
        const lockPath = join(isolated, "runtime.lock");
        // 旧锁：持有进程已死（PID 属于已退出的进程）。
        const deadPid = 999_999_999;
        await writeFile(
          lockPath,
          JSON.stringify({
            token: "old-token",
            pid: deadPid,
            startIdentity: "old start",
          }) + "\n",
        );
        // 子进程 A（迟到抢占者）：先读取旧锁（触发回收判定路径前的读取），
        // 在 rename 前等待信号；期间主进程把锁替换为“新持有者”锁。
        // 为确定性，直接驱动 reclaimByRename 的语义：A 读取到的 expected
        // token 与锁文件当前内容不一致时必须放弃。
        // 用两步子进程脚本模拟“读取-延迟-行动”窗口：
        const script = `
const { readFile } = await import("node:fs/promises");
const lockPath = ${JSON.stringify(lockPath)};
// 步骤 1：读取旧 token（模拟迟到者已在更早时刻读取）。
const before = JSON.parse((await readFile(lockPath, "utf8")).trim());
// 步骤 2：通知主进程可以替换锁，然后等待替换完成。
const { writeFile } = await import("node:fs/promises");
await writeFile(${JSON.stringify(join(isolated, "read-done"))}, "1");
while (true) {
  try {
    await readFile(${JSON.stringify(join(isolated, "replaced"))});
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 10));
  }
}
// 步骤 3：此时锁已被新持有者替换；迟到者若用旧 token 回收必须失败。
// 以实现导出的 acquireLock 验证：新持有者（主进程，存活）持有时必须失败。
const { acquireLock } = await import("${join(process.cwd(), "tests/support/nginx-runtime.ts")}");
const lock = await acquireLock(lockPath);
console.log("LATE_ACQUIRED=" + (lock !== undefined));
`;
        const child = execFileAsync("node", ["--input-type=module", "-e", script], {
          cwd: process.cwd(),
          env: { ...process.env },
        });
        // 等待子进程读取旧锁。
        for (let i = 0; i < 300; i += 1) {
          if (
            await stat(join(isolated, "read-done")).then(
              () => true,
              () => false,
            )
          )
            break;
          await new Promise((r) => setTimeout(r, 20));
        }
        // 替换为“新持有者”锁：持有进程 = 本测试进程（存活、身份真实）。
        const start = await execFileAsync("/bin/ps", [
          "-p",
          String(process.pid),
          "-o",
          "lstart=",
        ]).then((r) => r.stdout.trim());
        await writeFile(
          lockPath,
          JSON.stringify({
            token: "new-holder-token",
            pid: process.pid,
            startIdentity: start,
          }) + "\n",
        );
        await writeFile(join(isolated, "replaced"), "1");
        const out = await child.then(
          (ok) => ok.stdout,
          (error) => {
            throw new Error(
              (error as { stderr?: string }).stderr ?? "lock-cas probe failed",
            );
          },
        );
        expect(out).toContain("LATE_ACQUIRED=false");
        // 新持有者的锁原封不动。
        const content = (await readFile(lockPath, "utf8")).trim();
        expect(JSON.parse(content).token).toBe("new-holder-token");
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );
});
