import { readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensureNginxRuntime,
  findFreePort,
  listDevhotNginxPids,
  serveWithNginx,
  type NginxServer,
} from "../support/nginx-runtime";
import { securityHeaders } from "../../tools/verify-serving";
import { buildReaderFixture } from "../support/browser-server";

interface Probe {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const projectRoot = process.cwd();

const probe = async (url: string): Promise<Probe> => {
  const response = await fetch(url, { redirect: "manual" });
  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body };
};

const expectSecurityHeaders = (probeResult: Probe): void => {
  for (const [name, value] of Object.entries(securityHeaders)) {
    expect(probeResult.headers[name.toLowerCase()], name).toBe(value);
  }
  expect(probeResult.headers["strict-transport-security"]).toBeUndefined();
};

const findAsset = async (distRoot: string, directory: string, suffix: string) => {
  const entries = await readdir(join(distRoot, directory), { recursive: true });
  const match = entries.find((entry) => entry.endsWith(suffix));
  if (!match) throw new Error(`no ${suffix} under ${directory}`);
  return `${directory}/${match}`;
};

const execFileAsync = promisify(execFile) as (
  command: string,
  args: string[],
) => Promise<{ stdout: string }>;

/** 全文件级快照：本测试文件启动任何 Nginx 之前记录一次。 */
interface FileSnapshot {
  readonly pids: readonly number[];
  readonly ports: readonly number[];
  readonly confDirs: readonly string[];
}

const listNginxListenPorts = async (): Promise<readonly number[]> => {
  const ports: number[] = [];
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    for (const line of stdout.split("\n")) {
      if (line.includes("nginx")) {
        const match = line.match(/127\.0\.0\.1:(\d+)/);
        if (match) ports.push(Number(match[1]));
      }
    }
  } catch {
    // lsof 不可用时退化为 ps 检查（端口断言跳过，进程断言仍有效）。
  }
  return ports;
};

const listConfDirs = async (): Promise<readonly string[]> => {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith("devhot-nginx-conf-")).sort();
};

const snapshotBeforeFile = {
  pids: await listDevhotNginxPids(),
  ports: await listNginxListenPorts(),
  confDirs: await listConfDirs(),
} satisfies FileSnapshot;

const assertNoNewResidue = async (context: string): Promise<void> => {
  const [pids, ports, confDirs] = await Promise.all([
    listDevhotNginxPids(),
    listNginxListenPorts(),
    listConfDirs(),
  ]);
  const addedPids = pids.filter((pid) => !snapshotBeforeFile.pids.includes(pid));
  const addedPorts = ports.filter((port) => !snapshotBeforeFile.ports.includes(port));
  const addedDirs = confDirs.filter((dir) => !snapshotBeforeFile.confDirs.includes(dir));
  if (addedPids.length + addedPorts.length + addedDirs.length > 0) {
    throw new Error(
      `${context} left new nginx residue: pids=[${addedPids.join(",")}] ` +
        `ports=[${addedPorts.join(",")}] confDirs=[${addedDirs.join(",")}] ` +
        `(baseline pids=[${snapshotBeforeFile.pids.join(",")}] ` +
        `ports=[${snapshotBeforeFile.ports.join(",")}] ` +
        `dirs=[${snapshotBeforeFile.confDirs.join(",")}])`,
    );
  }
};

/** 每个实例 stop() 后的完整断言：进程树、端口、目录全部消失。 */
const assertInstanceGone = async (instance: NginxServer): Promise<void> => {
  const pids = await listDevhotNginxPids();
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,stat,command"]);
  const workers = stdout
    .split("\n")
    .filter(
      (line) =>
        !/^\s*\d+\s+\d+\s+Z/.test(line) &&
        line.includes("nginx: worker process") &&
        (line.includes(String(instance.masterPid)) || line.includes(instance.configDir)),
    );
  expect(
    pids.includes(instance.masterPid),
    `master pid ${instance.masterPid} still alive (configDir=${instance.configDir})`,
  ).toBe(false);
  expect(
    workers,
    `workers of master ${instance.masterPid} still alive (configDir=${instance.configDir})`,
  ).toEqual([]);
  await expect(
    stat(instance.configDir),
    `configDir ${instance.configDir} still exists`,
  ).rejects.toThrow();
};

describe("pinned nginx runtime security and cache policy", () => {
  let server: NginxServer;
  let cleanupBuild: () => Promise<void>;
  let mediaAsset = "";
  let astroAsset = "";
  let fragmentPath = "";

  beforeAll(async () => {
    const nginxBinary = await ensureNginxRuntime();
    const build = await buildReaderFixture();
    cleanupBuild = build.cleanup;
    mediaAsset = await findAsset(build.distRoot, "media/sha256", ".png");
    astroAsset = await findAsset(build.distRoot, "_astro", ".css");
    const fragments = await readdir(
      join(build.distRoot, "timeline", "fragments", "software-engineering", "day"),
    );
    fragmentPath = `timeline/fragments/software-engineering/day/${fragments[0]}`;
    server = await serveWithNginx(
      nginxBinary,
      build.distRoot,
      join(projectRoot, "deploy", "nginx-serving.conf"),
      join(projectRoot, "deploy", "security-headers.conf"),
      await findFreePort(),
    );
  }, 600_000);

  afterAll(async () => {
    // 清理错误不得被吞掉：stop 与 fixture cleanup 都必须执行并如实暴露错误。
    const results = await Promise.allSettled([server.stop(), cleanupBuild()]);
    // 本组实例的精确身份断言：进程树、端口、目录全部消失。
    await assertInstanceGone(server);
    // 全文件增量断言：不得新增任何进程/端口/目录。
    await assertNoNewResidue("security suite");
    const reasons = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as Error);
    if (reasons.length > 0) {
      throw new AggregateError(reasons, "nginx runtime suite teardown failed");
    }
  });

  it("serves HTML pages with revalidation and full security headers", async () => {
    const page = await probe(`${server.origin}/software-engineering/`);
    expect(page.status).toBe(200);
    expectSecurityHeaders(page);
    expect(page.headers["cache-control"]).toBe("no-cache, must-revalidate");
    expect(page.body).toContain("近期洞察");
  });

  it("serves release and publication metadata with revalidation", async () => {
    for (const path of ["/release.json", "/_publication.json"]) {
      const result = await probe(`${server.origin}${path}`);
      expect(result.status).toBe(200);
      expectSecurityHeaders(result);
      expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");
      expect(result.headers["content-type"]).toContain("application/json");
    }
  });

  it("serves maintenance JSON with revalidation and no HTML", async () => {
    const result = await probe(`${server.origin}/maintenance/reminders.json`);
    expect(result.status).toBe(200);
    expectSecurityHeaders(result);
    expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");

    const missing = await probe(`${server.origin}/maintenance/missing-page/`);
    expect(missing.status).toBe(404);
    expectSecurityHeaders(missing);
    expect(missing.headers["cache-control"]).toBe("no-cache, must-revalidate");
  });

  it("serves timeline fragments with revalidation", async () => {
    const result = await probe(`${server.origin}/${fragmentPath}`);
    expect(result.status).toBe(200);
    expectSecurityHeaders(result);
    expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");
    expect(JSON.parse(result.body).schemaVersion).toBe(1);
  });

  it("caches content-addressed and hashed assets immutably", async () => {
    for (const asset of [mediaAsset, astroAsset]) {
      const result = await probe(`${server.origin}/${asset}`);
      expect(result.status).toBe(200);
      expectSecurityHeaders(result);
      expect(result.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    }
  });

  it("serves missing hashed assets as 404 with revalidation, never immutable", async () => {
    // 两个哈希资源路径下的 404 都必须重验证并保留全部安全头，
    // 绝不能继承 immutable 一年缓存。
    for (const path of ["/media/sha256/missing.png", "/_astro/missing.abc123.css"]) {
      const result = await probe(`${server.origin}${path}`);
      expect(result.status, path).toBe(404);
      expectSecurityHeaders(result);
      expect(result.headers["cache-control"], path).toBe("no-cache, must-revalidate");
    }
  });

  it("keeps security headers on 404 responses", async () => {
    const result = await probe(`${server.origin}/no-such-page/`);
    expect(result.status).toBe(404);
    expectSecurityHeaders(result);
    expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");
  });

  it("does not send HSTS or redirect to HTTPS anywhere", async () => {
    for (const path of [
      "/software-engineering/",
      "/release.json",
      `/${mediaAsset}`,
      "/missing/",
    ]) {
      const result = await probe(`${server.origin}${path}`);
      expect(result.headers["strict-transport-security"]).toBeUndefined();
      expect(result.headers["location"]).toBeUndefined();
    }
  });

  it("answers conditional requests with 304 for revalidated paths", async () => {
    const first = await fetch(`${server.origin}/software-engineering/`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const conditional = await fetch(`${server.origin}/software-engineering/`, {
      headers: { "If-None-Match": etag ?? "" },
      redirect: "manual",
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  });
});

describe("pinned nginx runtime process lifecycle", () => {
  let build: Awaited<ReturnType<typeof buildReaderFixture>>;

  beforeAll(async () => {
    build = await buildReaderFixture();
  }, 600_000);

  afterAll(async () => {
    const results = await Promise.allSettled([build.cleanup()]);
    await assertNoNewResidue("lifecycle suite");
    const reasons = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as Error);
    if (reasons.length > 0) {
      throw new AggregateError(reasons, "lifecycle suite teardown failed");
    }
  });

  const startInstance = async () => {
    const nginxBinary = await ensureNginxRuntime();
    return serveWithNginx(
      nginxBinary,
      build.distRoot,
      join(projectRoot, "deploy", "nginx-serving.conf"),
      join(projectRoot, "deploy", "security-headers.conf"),
      await findFreePort(),
    );
  };

  it(
    "verifies spawn pid, pid file, and listener identity match, then stops cleanly",
    { timeout: 30_000 },
    async () => {
      const instance = await startInstance();
      let testError: unknown;
      try {
        // 启动成功契约：pid 文件 master PID === spawn PID（serveWithNginx 内已
        // 断言，此处复核并记录），HTTP 可用，端口由本实例进程树持有。
        const pidFile = await (
          await import("node:fs/promises")
        ).readFile(join(instance.configDir, "nginx.pid"), "utf8");
        expect(Number.parseInt(pidFile.trim(), 10)).toBe(instance.masterPid);
        const beforeStop = await fetch(`${instance.origin}/release.json`);
        expect(beforeStop.status).toBe(200);
        const pids = await listDevhotNginxPids();
        expect(pids).toContain(instance.masterPid);

        await instance.stop();
        await assertInstanceGone(instance);
      } catch (error) {
        testError = error;
        throw error;
      } finally {
        if (testError !== undefined) {
          await instance.retryCleanupAfterFailure().catch((cleanupError: unknown) => {
            throw new AggregateError(
              [testError as Error, cleanupError as Error],
              "identity test failed and cleanup failed",
            );
          });
        }
      }
    },
  );

  it(
    "cleans up through finally when a mid-test assertion throws",
    { timeout: 30_000 },
    async () => {
      const instance = await startInstance();
      try {
        await fetch(`${instance.origin}/release.json`);
        // 故意失败：证明 finally 中的 stop() 仍会清理本实例。
        throw new Error("deliberate mid-test failure");
      } catch (error) {
        expect((error as Error).message).toContain("deliberate mid-test failure");
      } finally {
        await instance.stop();
      }
      await assertInstanceGone(instance);
    },
  );

  it(
    "escalates to SIGKILL when the master ignores SIGTERM",
    { timeout: 60_000 },
    async () => {
      const instance = await startInstance();
      // SIGSTOP 暂停 master：SIGTERM 无法被处理（等价于忽略 SIGTERM），
      // stop() 必须在超时后真实发送 SIGKILL 终止被暂停的进程并完成清理。
      process.kill(instance.masterPid, "SIGSTOP");
      try {
        await instance.stop();
        await assertInstanceGone(instance);
      } finally {
        // 兜底：若 stop() 因缺陷失败，恢复调度后确保清理（SIGCONT 后
        // 排队的 SIGTERM 会生效）。
        try {
          process.kill(instance.masterPid, "SIGCONT");
        } catch {
          // 已退出则无需恢复。
        }
        await instance.retryCleanupAfterFailure();
      }
    },
  );

  it(
    "resolves repeated stop() calls with the same shared cleanup result",
    { timeout: 30_000 },
    async () => {
      const instance = await startInstance();
      try {
        await fetch(`${instance.origin}/release.json`);
        // 并发与重复 stop() 都等待同一次清理，结果一致（成功）。
        const [first, second] = await Promise.all([instance.stop(), instance.stop()]);
        const third = await instance.stop();
        expect(first).toBeUndefined();
        expect(second).toBeUndefined();
        expect(third).toBeUndefined();
      } finally {
        // 若主体失败则确保清理；成功路径共享 Promise 已完成，重试等价于幂等确认。
        await instance.retryCleanupAfterFailure();
      }
      await assertInstanceGone(instance);
    },
  );

  it(
    "fails loudly when the temp directory cannot be removed",
    { timeout: 30_000 },
    async () => {
      // 用注入的删除钩子确定性模拟 rm 失败（root 用户会绕过权限位，
      // 因此不能依赖 chmod）。
      const failures: string[] = [];
      const nginxBinary = await ensureNginxRuntime();
      const instance = await serveWithNginx(
        nginxBinary,
        build.distRoot,
        join(projectRoot, "deploy", "nginx-serving.conf"),
        join(projectRoot, "deploy", "security-headers.conf"),
        await findFreePort(),
        {
          removeConfigDir: async (path) => {
            failures.push(`simulated EACCES: ${path}`);
            throw new Error("EACCES: simulated permission failure");
          },
        },
      );
      try {
        // stop() 必须失败且错误包含目录与实例身份；进程树仍被完整终止。
        await expect(instance.stop()).rejects.toThrow(/failed to remove/);
        expect(failures).toHaveLength(1);
        await assertProcessTreeGone(instance);
      } finally {
        // 失败后通过重试入口恢复真实删除，完成清理。
        await instance.retryCleanupAfterFailure();
      }
      await assertInstanceGone(instance);
    },
  );

  it("rejects an invalid nginx config at setup and removes the configDir", async () => {
    const nginxBinary = await ensureNginxRuntime();
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const brokenRoot = await mkdtemp(join(tmpdir(), "devhot-broken-conf-"));
    const brokenServing = join(brokenRoot, "nginx-serving.conf");
    const brokenHeaders = join(brokenRoot, "security-headers.conf");
    await writeFile(
      brokenServing,
      "server {\n    listen 8080;\n    this is not valid nginx syntax ;;;\n}\n",
    );
    await writeFile(brokenHeaders, "");
    const dirsBefore = await listConfDirs();
    try {
      // nginx -t 必须失败，且失败路径删除本次创建的 configDir。
      await expect(
        serveWithNginx(
          nginxBinary,
          build.distRoot,
          brokenServing,
          brokenHeaders,
          await findFreePort(),
        ),
      ).rejects.toThrow(/exited with/);
      const dirsAfter = await listConfDirs();
      const added = dirsAfter.filter((dir) => !dirsBefore.includes(dir));
      expect(added).toEqual([]);
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });

  it("rejects an invalid binary at spawn and still cleans the configDir", async () => {
    const dirsBefore = await listConfDirs();
    // binary 不存在：spawn error 路径，目录必须被删除。
    await expect(
      serveWithNginx(
        join(tmpdir(), "devhot-no-such-binary", "nginx"),
        build.distRoot,
        join(projectRoot, "deploy", "nginx-serving.conf"),
        join(projectRoot, "deploy", "security-headers.conf"),
        await findFreePort(),
      ),
    ).rejects.toThrow();
    const dirsAfter = await listConfDirs();
    const added = dirsAfter.filter((dir) => !dirsBefore.includes(dir));
    expect(added).toEqual([]);
  });

  it(
    "reclaims its configDir when a foreign service holds the port",
    { timeout: 30_000 },
    async () => {
      const { createServer } = await import("node:http");
      const blocker = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("foreign placeholder");
      });
      await new Promise<void>((resolvePromise) =>
        blocker.listen(0, "127.0.0.1", () => resolvePromise()),
      );
      const blockedPort = (blocker.address() as { port: number }).port;
      const nginxBinary = await ensureNginxRuntime();
      const dirsBefore = await listConfDirs();
      let configDirLeft: string | undefined;
      try {
        // 本实例 nginx 绑定失败退出：启动错误保留，目录必须被回收。
        const thrown = await serveWithNginx(
          nginxBinary,
          build.distRoot,
          join(projectRoot, "deploy", "nginx-serving.conf"),
          join(projectRoot, "deploy", "security-headers.conf"),
          blockedPort,
        ).then(
          (instance) => instance,
          (error: unknown) => {
            const message = (error as Error).message;
            if (!/did not become reachable|exited before readiness/.test(message)) {
              throw error;
            }
            return undefined;
          },
        );
        if (thrown !== undefined) {
          await thrown.stop();
          throw new Error("expected startup failure but instance started");
        }
        // 目录已删除：本次运行不新增 devhot-nginx-conf-*。
        const dirsAfter = await listConfDirs();
        const added = dirsAfter.filter((dir) => !dirsBefore.includes(dir));
        if (added.length > 0) {
          configDirLeft = added[0];
          throw new Error(
            `configDir leaked while foreign service holds port: ${added.join(",")}`,
          );
        }
        // 占位服务不受影响：仍正常响应。
        const probe = await fetch(`http://127.0.0.1:${blockedPort}/`);
        expect(probe.status).toBe(200);
      } finally {
        await new Promise<void>((resolvePromise) =>
          blocker.close(() => resolvePromise()),
        );
        const { rm } = await import("node:fs/promises");
        if (configDirLeft) {
          await rm(join(tmpdir(), configDirLeft), { recursive: true, force: true });
        }
      }
    },
  );

  it(
    "preserves both startup and cleanup errors when both fail",
    { timeout: 30_000 },
    async () => {
      // 启动失败（端口被占）+ cleanup 失败（removeConfigDir 注入）：
      // 两类错误都必须保留在 AggregateError 中。
      const { createServer } = await import("node:http");
      // 正常响应 HTTP 的占位服务（不是立即断开的 socket）：端口被无关服务
      // 持有时，本实例 nginx 启动失败，但清理不得把无关监听者当作自身残留。
      const blocker = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("foreign placeholder");
      });
      await new Promise<void>((resolvePromise) =>
        blocker.listen(0, "127.0.0.1", () => resolvePromise()),
      );
      const blockedPort = (blocker.address() as { port: number }).port;
      const nginxBinary = await ensureNginxRuntime();
      // serveWithNginx 失败抛出后拿不到实例句柄，因此记录目录集合，在
      // finally 中只清理本测试新出现的 devhot-nginx-conf-*（注入失败被
      // 有意保留的那一个）。
      const dirsBefore = await listConfDirs();
      try {
        const attempt = serveWithNginx(
          nginxBinary,
          build.distRoot,
          join(projectRoot, "deploy", "nginx-serving.conf"),
          join(projectRoot, "deploy", "security-headers.conf"),
          blockedPort,
          {
            removeConfigDir: async () => {
              throw new Error("EACCES: simulated remove failure");
            },
          },
        );
        const thrown = await attempt.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(thrown).toBeInstanceOf(AggregateError);
        const aggregate = thrown as AggregateError;
        const messages = aggregate.errors.map((error) => (error as Error).message);
        // startup/readiness 错误与 cleanup/remove 错误都必须在场。
        expect(
          messages.some((message) =>
            /did not become reachable|exited before readiness/.test(message),
          ),
          `missing startup error in ${JSON.stringify(messages)}`,
        ).toBe(true);
        expect(
          messages.some((message) =>
            /failed to remove|remove failure|cleanup failed|still listening|survived/.test(
              message,
            ),
          ),
          `missing cleanup error in ${JSON.stringify(messages)}`,
        ).toBe(true);
      } finally {
        await new Promise<void>((resolvePromise) =>
          blocker.close(() => resolvePromise()),
        );
        const { rm } = await import("node:fs/promises");
        for (const dir of await listConfDirs()) {
          if (!dirsBefore.includes(dir)) {
            await rm(join(tmpdir(), dir), { recursive: true, force: true });
          }
        }
      }
    },
  );
});

// 进程树断言（目录可能仍存在，用于 removeConfigDir 失败场景）。
const assertProcessTreeGone = async (instance: NginxServer): Promise<void> => {
  const pids = await listDevhotNginxPids();
  expect(
    pids.includes(instance.masterPid),
    `master pid ${instance.masterPid} still alive after stop`,
  ).toBe(false);
};
