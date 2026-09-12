import {
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
  chmod,
  readFile,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureNginxRuntime,
  findFreePort,
  serveWithNginx,
  NGINX_VERSION,
  NGINX_TARBALL_SHA256,
} from "../support/nginx-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile) as (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

// 旧实现的真实目录身份固定为 recipe v2；历史锁反例复用同一计算。
const legacyRuntimeDirName = (): string => {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        recipeVersion: 2,
        nginxVersion: NGINX_VERSION,
        tarballSha256: NGINX_TARBALL_SHA256,
        configureArgs: ["--without-http_gzip_module"],
        platform: process.platform,
        arch: process.arch,
      }),
    )
    .digest("hex");
  return `devhot-nginx-${NGINX_VERSION}-${fingerprint.slice(0, 16)}`;
};

describe("pinned nginx runtime isolation and integrity", () => {
  describe("active runtime validation", () => {
    let binary: string;
    let root: string;
    let snapshot: string;
    let markerText: string;
    let originalSha: string;

    beforeAll(async () => {
      binary = await ensureNginxRuntime();
      root = dirname(dirname(binary));
      snapshot = await mkdtemp(join(tmpdir(), "devhot-runtime-snapshot-"));
      await cp(root, join(snapshot, "runtime"), { recursive: true });
      markerText = await readFile(join(root, ".install-complete"), "utf8");
      originalSha = createHash("sha256")
        .update(await readFile(binary))
        .digest("hex");
    }, 300_000);

    afterAll(async () => {
      if (snapshot !== undefined) await rm(snapshot, { recursive: true, force: true });
    });

    const assertValidated = async (): Promise<void> => {
      expect(await ensureNginxRuntime()).toBe(binary);
      expect(await readFile(join(root, ".install-complete"), "utf8")).toBe(markerText);
      expect(
        createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
      ).toBe(originalSha);
      // execFileAsync 的非零退出会直接失败；独立断言精确版本行与 prefix。
      const result = await execFileAsync(binary, ["-V"]);
      const lines = (result.stdout + "\n" + result.stderr)
        .split("\n")
        .map((line) => line.trim());
      expect(lines).toContain("nginx version: nginx/" + NGINX_VERSION);
      const configure = lines.find((line) => line.startsWith("configure arguments:"));
      const args = configure?.slice("configure arguments:".length).trim().split(/\s+/);
      expect(args).toContain("--prefix=" + root);
      expect(args).toContain("--without-http_gzip_module");
    };

    // 真实构建一次。对当前运行时逐项篡改，阻断重新下载以证明 ensure
    // 已拒绝当前内容并进入重建；随后还原本测试快照，独立验证完整证据。
    // 自动重新编译恢复另由下方 reswap 黑盒反例覆盖。
    const expectRejected = async (mutate: () => Promise<void>): Promise<void> => {
      const preparedSource = process.env.DEVHOT_NGINX_SOURCE_TARBALL;
      delete process.env.DEVHOT_NGINX_SOURCE_TARBALL;
      const denied = new Error("controlled rebuild download failure");
      const download = vi.spyOn(globalThis, "fetch").mockRejectedValue(denied);
      try {
        await mutate();
        await expect(ensureNginxRuntime()).rejects.toBe(denied);
        expect(download).toHaveBeenCalledTimes(1);
        // 在进程退出前就确认失败构建已经删除整个自有根目录。
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        download.mockRestore();
        if (preparedSource !== undefined)
          process.env.DEVHOT_NGINX_SOURCE_TARBALL = preparedSource;
        await rm(root, { recursive: true, force: true });
        await cp(join(snapshot, "runtime"), root, { recursive: true });
      }
      await assertValidated();
    };

    it("accepts the real runtime with complete evidence", assertValidated);

    it("rejects an active runtime with a missing marker", async () => {
      await expectRejected(() => rm(join(root, ".install-complete")));
    });

    it.each(["", "{", "null"])("rejects malformed active marker %j", async (text) => {
      await expectRejected(() => writeFile(join(root, ".install-complete"), text));
    });

    it.each([
      ["schemaVersion", 99],
      ["nginxVersion", "0.0.0"],
      ["tarballSha256", "0".repeat(64)],
      ["recipeFingerprint", "0".repeat(64)],
      ["binarySha256", "0".repeat(64)],
    ])("rejects changed active marker field %s", async (field, value) => {
      await expectRejected(async () => {
        const marker = JSON.parse(markerText) as Record<string, unknown>;
        marker[String(field)] = value;
        await writeFile(join(root, ".install-complete"), JSON.stringify(marker));
      });
    });

    it.each([
      "schemaVersion",
      "nginxVersion",
      "tarballSha256",
      "recipeFingerprint",
      "binarySha256",
    ])("rejects missing active marker field %s", async (field) => {
      await expectRejected(async () => {
        const marker = JSON.parse(markerText) as Record<string, unknown>;
        delete marker[field];
        await writeFile(join(root, ".install-complete"), JSON.stringify(marker));
      });
    });

    it("rejects an active binary whose bytes disagree with its marker", async () => {
      await expectRejected(() => writeFile(binary, "#!/bin/sh\nexit 0\n"));
    });

    it.each([
      {
        name: "correct output but exit 42",
        code: 42,
        versionSuffix: "",
        prefixSuffix: "",
        args: "--without-http_gzip_module",
      },
      {
        name: "wrong prefix with matching binary SHA",
        code: 0,
        versionSuffix: "",
        prefixSuffix: "-wrong",
        args: "--without-http_gzip_module",
      },
      {
        name: "version prefix lookalike",
        code: 0,
        versionSuffix: "-wrong",
        prefixSuffix: "",
        args: "--without-http_gzip_module",
      },
      {
        name: "missing configure argument",
        code: 0,
        versionSuffix: "",
        prefixSuffix: "",
        args: "",
      },
      {
        name: "configure argument prefix lookalike",
        code: 0,
        versionSuffix: "",
        prefixSuffix: "",
        args: "--without-http_gzip_module-wrong",
      },
    ])(
      "rejects $name in the active runtime",
      async ({ code, versionSuffix, prefixSuffix, args }) => {
        await expectRejected(async () => {
          const output =
            "nginx version: nginx/" +
            NGINX_VERSION +
            versionSuffix +
            "\n" +
            "configure arguments: --prefix=" +
            root +
            prefixSuffix +
            " " +
            args;
          const quoted = "'" + output.replaceAll("'", "'\\''") + "'";
          await writeFile(
            binary,
            "#!/bin/sh\nprintf '%s\\n' " + quoted + "\nexit " + code + "\n",
          );
          await chmod(binary, 0o755);
          const marker = JSON.parse(markerText) as Record<string, unknown>;
          marker.binarySha256 = createHash("sha256")
            .update(await readFile(binary))
            .digest("hex");
          await writeFile(join(root, ".install-complete"), JSON.stringify(marker));
        });
      },
    );

    it("removes the whole owned root when a downloaded tarball fails integrity", async () => {
      const preparedSource = process.env.DEVHOT_NGINX_SOURCE_TARBALL;
      delete process.env.DEVHOT_NGINX_SOURCE_TARBALL;
      const download = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("corrupt tarball"));
      try {
        await rm(join(root, ".install-complete"));
        await expect(ensureNginxRuntime()).rejects.toThrow("tarball sha256 mismatch");
        expect(download).toHaveBeenCalledTimes(1);
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        download.mockRestore();
        if (preparedSource !== undefined)
          process.env.DEVHOT_NGINX_SOURCE_TARBALL = preparedSource;
        await rm(root, { recursive: true, force: true });
        await cp(join(snapshot, "runtime"), root, { recursive: true });
      }
      await assertValidated();
    });
  });

  it(
    "in-process concurrent prepare calls converge on one validated runtime",
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
    "two independent processes build in isolated roots without locks or residue",
    { timeout: 600_000 },
    async () => {
      // 两个独立 Node 进程同步起跑。每个进程只写自己的唯一运行时根，
      // 因而不需要共享锁、陈旧回收或跨进程 CAS。
      const isolated = await mkdtemp(join(tmpdir(), "devhot-runtime-race-"));
      try {
        const script = `
import { ensureNginxRuntime } from "./tests/support/nginx-runtime.ts";
import { stat, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const barrier = process.env.BARRIER_PATH;
// 就绪屏障：各自写自己的 ready 文件，等待两份都出现后同时起跑。
await writeFile(barrier + ".ready", "1");
const other = process.env.OTHER_BARRIER;
let otherReady = false;
for (let i = 0; i < 600; i += 1) {
  try {
    await stat(other + ".ready");
    otherReady = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}
if (!otherReady) throw new Error("other runtime process never reached the barrier");
const startAt = Date.now() + 150;
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 5));
const resolved = await ensureNginxRuntime();
console.log("RACE_DONE=" + resolved);
const marker = JSON.parse(
  await readFile(resolved.replace("/sbin/nginx", "/.install-complete"), "utf8"),
);
const actual = createHash("sha256").update(await readFile(resolved)).digest("hex");
console.log("RACE_VALID=" + (marker.binarySha256 === actual));
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
        // 即使某一子进程失败，也等待另一个退出后才能删除共享测试目录。
        const results = await Promise.allSettled([runChild("1"), runChild("2")]);
        const [first, second] = results.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
        const done1 = first!.match(/RACE_DONE=(.*)/)?.[1] ?? "";
        const done2 = second!.match(/RACE_DONE=(.*)/)?.[1] ?? "";
        // 两个进程各自拿到内容完整、互不共享的路径。
        expect(done1.endsWith("sbin/nginx")).toBe(true);
        expect(done2.endsWith("sbin/nginx")).toBe(true);
        expect(done1).not.toBe(done2);
        expect(first).toContain("RACE_VALID=true");
        expect(second).toContain("RACE_VALID=true");
        // 子进程退出会清理自己的运行时；无 lock/stale 残留。
        await expect(stat(dirname(dirname(done1)))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(dirname(dirname(done2)))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const leftovers = (await readdir(isolated)).filter(
          (entry) =>
            entry.startsWith("devhot-nginx-") ||
            entry.includes(".lock") ||
            entry.includes("stale-"),
        );
        expect(leftovers).toEqual([]);
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );

  it(
    "re-verifies the process-owned runtime on every call after preparation",
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
const ok = await execFileAsync(second, ["-V"]);
const lines = ((ok.stdout || "") + "\\n" + (ok.stderr || "")).split("\\n").map((line) => line.trim());
const args = lines.find((line) => line.startsWith("configure arguments:"))?.slice("configure arguments:".length).trim().split(/\\s+/);
console.log(
  "SECOND_REAL=" +
    (lines.includes("nginx version: nginx/1.30.4") && args?.includes("--prefix=" + second.replace("/sbin/nginx", ""))),
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

describe("runtime cleanup failure reporting", () => {
  it.each([
    { mode: "async", initialCode: 0, expectedCode: 0 },
    { mode: "exit", initialCode: 0, expectedCode: 1 },
    { mode: "exit", initialCode: 17, expectedCode: 17 },
  ])(
    "reports $mode cleanup failure with initial exit code $initialCode",
    async ({ mode, initialCode, expectedCode }) => {
      const isolated = await mkdtemp(join(tmpdir(), "devhot-runtime-cleanup-failure-"));
      try {
        // 仅在子进程替换内置 fs 调用，故障限定为该进程的精确自有根目录。
        // 下载在创建 src 后立即失败，不编译、不启动 Nginx。
        const script = `
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const mode = process.env.PROBE_MODE;
const isolated = process.env.TMPDIR;
const realRm = fsp.rm;
const realRmSync = fs.rmSync;
const buildError = new Error("controlled download failure");
const cleanupError = new Error("controlled cleanup failure");
let root;
// This fault targets the download path, even when the parent prepared source.
delete process.env.DEVHOT_NGINX_SOURCE_TARBALL;
globalThis.fetch = async () => {
  const entries = (await fsp.readdir(isolated)).filter((name) => name.startsWith("devhot-nginx-"));
  if (entries.length !== 1) throw new Error("expected one process-owned root");
  root = join(isolated, entries[0]);
  throw buildError;
};
if (mode === "async") {
  fsp.rm = async (path, options) => {
    if (root !== undefined && path === root) throw cleanupError;
    return realRm(path, options);
  };
  syncBuiltinESMExports();
}
const { ensureNginxRuntime } = await import("./tests/support/nginx-runtime.ts");
let failure;
try { await ensureNginxRuntime(); } catch (error) { failure = error; }
if (root === undefined) throw new Error("download failure was not reached");
if (mode === "async") {
  console.log(JSON.stringify({
    aggregate: failure instanceof AggregateError,
    preservesBoth: failure?.errors?.[0] === buildError && failure?.errors?.[1] === cleanupError,
    rootRetained: (await fsp.stat(root)).isDirectory(),
  }));
  fsp.rm = realRm;
  syncBuiltinESMExports();
  await realRm(root, { recursive: true, force: true });
} else {
  if (failure !== buildError) throw new Error("unexpected build failure");
  // 失败构建正常清理后，重建本进程自有空目录以单独触发 exit 清理故障。
  await fsp.mkdir(root);
  fs.rmSync = (path, options) => {
    if (path === root) throw cleanupError;
    return realRmSync(path, options);
  };
  syncBuiltinESMExports();
  console.log(JSON.stringify({ root }));
  process.exitCode = Number(process.env.INITIAL_EXIT_CODE);
}
`;
        const result = await execFileAsync(
          "node",
          ["--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              TMPDIR: isolated,
              PROBE_MODE: mode,
              INITIAL_EXIT_CODE: String(initialCode),
            },
          },
        ).then(
          (ok) => ({ ...ok, code: 0 }),
          (error: { stdout: string; stderr: string; code: number }) => error,
        );
        expect(result.code).toBe(expectedCode);
        const evidence = JSON.parse(result.stdout.trim()) as {
          aggregate?: boolean;
          preservesBoth?: boolean;
          rootRetained?: boolean;
          root?: string;
        };
        if (mode === "async") {
          expect(evidence).toEqual({
            aggregate: true,
            preservesBoth: true,
            rootRetained: true,
          });
          expect(await readdir(isolated)).toEqual([]);
        } else {
          expect(result.stderr).toContain("failed to remove pinned nginx runtime");
          expect(result.stderr).toContain("controlled cleanup failure");
          expect(dirname(evidence.root!)).toBe(isolated);
          expect((await stat(evidence.root!)).isDirectory()).toBe(true);
        }
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
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
    "an empty legacy lock cannot block or be modified by runtime preparation",
    { timeout: 300_000 },
    async () => {
      // 旧实现若在 O_EXCL 创建后、写 JSON 前崩溃，会留下 0 字节锁。
      // 新实现不读取或回收它，因此它不能阻断新进程的唯一目录构建。
      const isolated = await mkdtemp(join(tmpdir(), "lock-age-"));
      try {
        const lockPath = join(isolated, `${legacyRuntimeDirName()}.lock`);
        await writeFile(lockPath, "");
        const before = await stat(lockPath);

        // 子进程准备自己的固定运行时，不访问这把历史锁。
        const probe = `
const { ensureNginxRuntime } = await import("${join(process.cwd(), "tests/support/nginx-runtime.ts")}");
const binary = await ensureNginxRuntime();
console.log("READY=" + binary.endsWith("/sbin/nginx"));
`;
        const result = await execFileAsync("node", ["--input-type=module", "-e", probe], {
          cwd: process.cwd(),
          env: { ...process.env, TMPDIR: isolated },
        }).then(
          (ok) => ok.stdout,
          (error) => {
            throw new Error(
              (error as { stderr?: string }).stderr ?? "lock-age probe failed",
            );
          },
        );
        expect(result).toContain("READY=true");
        // 历史锁未被移动、覆盖或删除。
        expect(await readFile(lockPath, "utf8")).toBe("");
        const after = await stat(lockPath);
        expect([after.ino, after.mtimeMs, after.size]).toEqual([
          before.ino,
          before.mtimeMs,
          before.size,
        ]);
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );

  it(
    "legacy lock replacement remains untouched during concurrent preparation",
    { timeout: 300_000 },
    async () => {
      // 即使历史锁在并发窗口内被替换，新运行时准备也不参与这套旧锁
      // 协议，因此不会移动或删除任何一方的文件。
      const isolated = await mkdtemp(join(tmpdir(), "lock-cas-"));
      let child: ReturnType<typeof execFileAsync> | undefined;
      try {
        const lockPath = join(isolated, `${legacyRuntimeDirName()}.lock`);
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
        // 子进程先观察旧文件，再等待主进程替换，随后独立准备运行时。
        const script = `
const { readFile } = await import("node:fs/promises");
const lockPath = ${JSON.stringify(lockPath)};
// 步骤 1：读取旧 token（模拟迟到者已在更早时刻读取）。
const before = JSON.parse((await readFile(lockPath, "utf8")).trim());
// 步骤 2：通知主进程可以替换锁，然后等待替换完成。
const { writeFile } = await import("node:fs/promises");
await writeFile(${JSON.stringify(join(isolated, "read-done"))}, "1");
let replaced = false;
for (let attempt = 0; attempt < 600; attempt += 1) {
  try {
    await readFile(${JSON.stringify(join(isolated, "replaced"))});
    replaced = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 10));
  }
}
if (!replaced) throw new Error("legacy lock replacement barrier timed out");
// 步骤 3：新实现不访问 lockPath，只准备进程唯一运行时。
const { ensureNginxRuntime } = await import("${join(process.cwd(), "tests/support/nginx-runtime.ts")}");
const binary = await ensureNginxRuntime();
console.log("LATE_READY=" + binary.endsWith("/sbin/nginx"));
`;
        child = execFileAsync("node", ["--input-type=module", "-e", script], {
          cwd: process.cwd(),
          env: { ...process.env, TMPDIR: isolated },
        });
        // 等待屏障期间也接收早退错误，统一在下方 await/finally 处理。
        void child.catch(() => {});
        // 等待子进程读取旧锁。
        let childReadDone = false;
        for (let i = 0; i < 300; i += 1) {
          if (
            await stat(join(isolated, "read-done")).then(
              () => true,
              () => false,
            )
          ) {
            childReadDone = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!childReadDone) throw new Error("legacy lock read barrier timed out");
        // 替换为“新持有者”锁：持有进程 = 本测试进程（存活、身份真实）。
        const start = await execFileAsync("/bin/ps", [
          "-p",
          String(process.pid),
          "-o",
          "lstart=",
        ]).then((r) => r.stdout.trim());
        const replacementPath = `${lockPath}.replacement`;
        await writeFile(
          replacementPath,
          JSON.stringify({
            token: "new-holder-token",
            pid: process.pid,
            startIdentity: start,
          }) + "\n",
        );
        const { rename } = await import("node:fs/promises");
        await rename(replacementPath, lockPath);
        const replacement = await stat(lockPath);
        await writeFile(join(isolated, "replaced"), "1");
        const out = await child.then(
          (ok) => ok.stdout,
          (error) => {
            throw new Error(
              (error as { stderr?: string }).stderr ?? "lock-cas probe failed",
            );
          },
        );
        expect(out).toContain("LATE_READY=true");
        // 新持有者的锁原封不动。
        const content = (await readFile(lockPath, "utf8")).trim();
        expect(JSON.parse(content).token).toBe("new-holder-token");
        const after = await stat(lockPath);
        expect([after.ino, after.mtimeMs, after.size]).toEqual([
          replacement.ino,
          replacement.mtimeMs,
          replacement.size,
        ]);
      } finally {
        await child?.catch(() => {});
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );
});
