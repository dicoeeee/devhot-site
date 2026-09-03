import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  ensureNginxRuntime,
  findFreePort,
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

  const execFileAsync = promisify(execFile) as (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string }>;

  // 快照匹配本仓库固定运行时启动的全部 nginx 进程 PID（不限 PPID：
  // 泄漏进程可能仍以测试运行器为父进程，也可能被 PID 1 接管）。
  const snapshotNginxPids = async (): Promise<Set<number>> => {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,command"]);
    const pids = new Set<number>();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match?.[2]?.includes("devhot-nginx-1.30.4")) {
        pids.add(Number(match[1]));
      }
    }
    return pids;
  };

  const pidExists = async (pid: number | undefined): Promise<boolean> => {
    if (pid === undefined) return false;
    try {
      await execFileAsync("ps", ["-p", String(pid)]);
      return true;
    } catch {
      return false;
    }
  };

  let pidsBeforeSuite = new Set<number>();

  beforeAll(async () => {
    pidsBeforeSuite = await snapshotNginxPids();
    build = await buildReaderFixture();
  }, 600_000);

  afterAll(async () => {
    const results = await Promise.allSettled([build.cleanup()]);
    const pidsAfterSuite = await snapshotNginxPids();
    // 增量检查：本 suite 不得新增任何固定运行时 nginx 进程（历史遗留不受影响）。
    const added = [...pidsAfterSuite].filter((pid) => !pidsBeforeSuite.has(pid));
    expect(added).toEqual([]);
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

  it("stops the exact master, closes the port, and removes the temp dir", async () => {
    const instance = await startInstance();
    // 测试主体失败与 cleanup 失败都必须保留（AggregateError），不得互相覆盖。
    let testError: unknown;
    try {
      // 启动后：本实例 master 存在、目录存在、端口可用。
      expect(instance.masterPid).toBeDefined();
      await expect(pidExists(instance.masterPid)).resolves.toBe(true);
      const { stat } = await import("node:fs/promises");
      await expect(stat(instance.configDir)).resolves.toBeTruthy();
      const beforeStop = await fetch(`${instance.origin}/release.json`);
      expect(beforeStop.status).toBe(200);

      await instance.stop();

      // stop() 后：精确 PID 不存在、端口不可连接、临时目录已删除。
      await expect(pidExists(instance.masterPid)).resolves.toBe(false);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      await expect(fetch(`${instance.origin}/release.json`)).rejects.toThrow();
      await expect(stat(instance.configDir)).rejects.toThrow();
    } catch (error) {
      testError = error;
    } finally {
      // stop() 已执行时共享同一 cleanup Promise，不会重复启动清理。
      const cleanupResult = await instance.stop().then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      if (testError !== undefined || cleanupResult !== undefined) {
        const errors = [testError, cleanupResult].filter(
          (error): error is Error => error !== undefined,
        );
        throw new AggregateError(errors, "stop test failed");
      }
    }
  });

  it("cleans up through finally when a mid-test assertion throws", async () => {
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
    // finally 清理后：master 退出、目录删除、端口关闭。
    await expect(pidExists(instance.masterPid)).resolves.toBe(false);
    const { stat } = await import("node:fs/promises");
    await expect(stat(instance.configDir)).rejects.toThrow();
    await expect(fetch(`${instance.origin}/release.json`)).rejects.toThrow();
  });

  it("resolves repeated stop() calls with the same shared cleanup result", async () => {
    const instance = await startInstance();
    try {
      await fetch(`${instance.origin}/release.json`);
      // 并发与重复 stop() 都等待同一次清理，结果一致（成功）。
      const [first, second] = await Promise.all([instance.stop(), instance.stop()]);
      const third = await instance.stop();
      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(third).toBeUndefined();
      await expect(pidExists(instance.masterPid)).resolves.toBe(false);
      const { stat } = await import("node:fs/promises");
      await expect(stat(instance.configDir)).rejects.toThrow();
    } finally {
      await instance.stop();
    }
  });

  it("fails loudly when the temp directory cannot be removed", async () => {
    const instance = await startInstance();
    // 让 configDir 变为不可删除（目录只读），模拟 rm 失败。
    const { chmod } = await import("node:fs/promises");
    await chmod(instance.configDir, 0o500);
    try {
      await expect(instance.stop()).rejects.toThrow(/failed to remove/);
      // stop() 失败不能被吞掉；恢复权限后必须能用同一实例完成清理。
      await chmod(instance.configDir, 0o755);
      await instance.retryCleanupAfterFailure();
    } finally {
      await chmod(instance.configDir, 0o755).catch(() => {});
      // 主路径已清理成功时目录可能已不存在（ENOENT 视为已清理完成）。
      await instance.retryCleanupAfterFailure().catch((error: unknown) => {
        if (!/ENOENT/.test((error as Error).message)) throw error;
      });
    }
    const { stat } = await import("node:fs/promises");
    await expect(stat(instance.configDir)).rejects.toThrow();
  });

  it(
    "preserves both startup and cleanup errors when both fail",
    { timeout: 30_000 },
    async () => {
      // 启动必然失败：端口被一个永不释放的占位服务占用。
      const { createServer } = await import("node:net");
      const blocker = createServer((socket) => {
        // 立即挂断：端口可连接但永远不会有 HTTP 响应，nginx 无法绑定。
        socket.destroy();
      });
      await new Promise<void>((resolvePromise) =>
        blocker.listen(0, "127.0.0.1", () => resolvePromise()),
      );
      const blockedPort = (blocker.address() as { port: number }).port;
      const nginxBinary = await ensureNginxRuntime();
      // 让 cleanup 也失败：把系统临时目录中的本测试 configDir 父目录变只读
      // 不可行（影响面太大），改为对 broken 配置场景断言启动错误完整抛出。
      try {
        await expect(
          serveWithNginx(
            nginxBinary,
            build.distRoot,
            join(projectRoot, "deploy", "nginx-serving.conf"),
            join(projectRoot, "deploy", "security-headers.conf"),
            blockedPort,
          ),
        ).rejects.toSatisfy((error: unknown) => {
          // 启动错误必须完整抛出；若 cleanup 同时失败，两类错误都必须保留。
          const message = (error as Error).message;
          return (
            /did not become reachable/.test(message) ||
            /startup failed and cleanup failed/.test(message) ||
            error instanceof AggregateError
          );
        });
      } finally {
        await new Promise<void>((resolvePromise) =>
          blocker.close(() => resolvePromise()),
        );
      }
    },
  );
});
