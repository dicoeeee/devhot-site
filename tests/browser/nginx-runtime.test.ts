import { readFile, readdir, rm, stat } from "node:fs/promises";
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

/**
 * 以进程组身份直接枚举本实例存活进程（ps 按 PGID 匹配，排除僵尸）：
 * 不依赖“命令行含运行时路径”的清单——worker 命令行不含该路径，
 * master 崩溃后也无法按 PPID/命令行识别孤儿。
 */
const instanceProcessPids = async (instance: NginxServer): Promise<number[]> => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,pgid,stat,command"]);
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const state = match[3] ?? "";
    if (
      pgid === instance.instancePgid &&
      !state.startsWith("Z") &&
      match[4]?.includes("nginx")
    ) {
      pids.push(pid);
    }
  }
  return pids;
};

/** 每个实例 stop() 后的完整断言：进程组、端口、目录全部消失。 */
/**
 * 全机真实 nginx 进程/监听端口/临时目录快照，用于测试前后增量断言：
 * 只断言“本次运行没有新增”，不要求机器上不存在其他 Nginx 实例
 * （与用户自建的独立服务正常共存）。
 */
const nginxSnapshot = async (): Promise<{
  pids: readonly number[];
  ports: readonly number[];
  dirs: readonly string[];
}> => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,command"]);
  const pids = stdout
    .split("\n")
    .filter((line) => /^\s*\d+\s+nginx:\s/.test(line))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
  const lsof = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]).catch(
    () => undefined,
  );
  const ports =
    lsof?.stdout
      .split("\n")
      .filter((line) => /nginx/.test(line))
      .map((line) => Number(line.match(/:(\d+)\s/)?.[1] ?? NaN))
      .filter((port) => Number.isInteger(port)) ?? [];
  return { pids, ports, dirs: await listConfDirs() };
};

const assertNoNewNginxResidue = async (before: {
  pids: readonly number[];
  ports: readonly number[];
  dirs: readonly string[];
}): Promise<void> => {
  const after = await nginxSnapshot();
  const addedPids = after.pids.filter((pid) => !before.pids.includes(pid));
  const addedPorts = after.ports.filter((port) => !before.ports.includes(port));
  const addedDirs = after.dirs.filter((dir) => !before.dirs.includes(dir));
  expect(addedPids, "new nginx processes left behind").toEqual([]);
  expect(addedPorts, "new nginx listeners left behind").toEqual([]);
  expect(addedDirs, "new nginx config dirs left behind").toEqual([]);
};

const assertInstanceGone = async (instance: NginxServer): Promise<void> => {
  const survivors = await instanceProcessPids(instance);
  expect(
    survivors,
    `processes of instance pgid ${instance.instancePgid} still alive: ${survivors.join(",")} (configDir=${instance.configDir})`,
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

  it("serves hashed-asset error responses with revalidation, never immutable", async () => {
    // 404（缺失）：两个哈希资源路径都必须重验证并保留全部安全头。
    for (const path of ["/media/sha256/missing.png", "/_astro/missing.abc123.css"]) {
      const result = await probe(`${server.origin}${path}`);
      expect(result.status, path).toBe(404);
      expectSecurityHeaders(result);
      expect(result.headers["cache-control"], path).toBe("no-cache, must-revalidate");
    }

    // 403（存在但不可读）：在两个路径下各放一个 000 模式文件。
    const { chmod, writeFile } = await import("node:fs/promises");
    const forbidden = [
      { asset: mediaAsset, name: "forbidden-media.png" },
      { asset: astroAsset, name: "forbidden-astro.css" },
    ];
    const { cp } = await import("node:fs/promises");
    const { resolve: resolvePath } = await import("node:path");
    const distRootAbs = server.configDir;
    for (const target of forbidden) {
      const source = join(distRootAbs, "dist", target.asset);
      const dest = join(
        distRootAbs,
        "dist",
        resolvePath(target.asset, ".."),
        target.name,
      );
      await cp(source, dest);
      await chmod(dest, 0o000);
    }
    try {
      for (const target of forbidden) {
        const path = `${resolvePath(target.asset, "..")}/${target.name}`;
        const result = await probe(`${server.origin}/${path}`);
        expect(result.status, path).toBe(403);
        expectSecurityHeaders(result);
        expect(result.headers["cache-control"], path).toBe("no-cache, must-revalidate");
      }
    } finally {
      // worker 以降权用户运行，恢复模式以便 teardown 删除临时 dist。
      for (const target of forbidden) {
        const path = join(
          distRootAbs,
          "dist",
          resolvePath(target.asset, ".."),
          target.name,
        );
        await chmod(path, 0o644).catch(() => {});
      }
    }

    // 416（越界 Range）：已有资源 + 不可满足的 Range 请求。nginx 对 416 的
    // 响应头过滤阶段可能重复追加同名头，断言以“绝不允许 immutable”为准。
    const rangeResponse = await fetch(`${server.origin}/${astroAsset}`, {
      headers: { Range: "bytes=999999999-1000000000" },
    });
    await rangeResponse.arrayBuffer();
    expect(rangeResponse.status).toBe(416);
    expect(rangeResponse.headers.get("cache-control")).toContain(
      "no-cache, must-revalidate",
    );
    expect(rangeResponse.headers.get("cache-control")).not.toContain("immutable");
    expect(rangeResponse.headers.get("content-security-policy")).toBeTruthy();

    // 412（前置条件失败）：不匹配的 If-Match 与早于修改时间的
    // If-Unmodified-Since。错误响应必须重验证，不得携带 immutable。
    const head = await fetch(`${server.origin}/${astroAsset}`);
    const etag = head.headers.get("etag") ?? "";
    const lastModified = head.headers.get("last-modified") ?? "";
    const staleSince = new Date(
      new Date(lastModified).getTime() - 86_400_000,
    ).toUTCString();
    for (const [label, headers] of [
      ["If-Match mismatch", { "If-Match": '"deadbeef"' }],
      ["If-Unmodified-Since stale", { "If-Unmodified-Since": staleSince }],
    ] as const) {
      const response = await fetch(`${server.origin}/${astroAsset}`, { headers });
      await response.arrayBuffer();
      expect(response.status, label).toBe(412);
      expect(response.headers.get("cache-control"), label).not.toContain("immutable");
      expect(response.headers.get("cache-control"), label).toContain(
        "no-cache, must-revalidate",
      );
      expect(response.headers.get("content-security-policy"), label).toBeTruthy();
    }

    // 405（方法不支持）：OPTIONS 请求同样不得携带 immutable。
    const optionsResponse = await fetch(`${server.origin}/${astroAsset}`, {
      method: "OPTIONS",
    });
    await optionsResponse.arrayBuffer();
    expect(optionsResponse.status).toBe(405);
    expect(optionsResponse.headers.get("cache-control")).not.toContain("immutable");
    expect(optionsResponse.headers.get("cache-control")).toContain(
      "no-cache, must-revalidate",
    );
    expect(optionsResponse.headers.get("content-security-policy")).toBeTruthy();
  });

  it("keeps immutable on successful and conditional hashed responses", async () => {
    // 正向回归：200 与 304 条件响应保持既定 immutable 策略（412 触发的
    // If-Match 携带匹配 ETag 时也应得到 200/304 而非错误分支）。
    const head = await fetch(`${server.origin}/${astroAsset}`);
    const etag = head.headers.get("etag") ?? "";
    const conditional = await fetch(`${server.origin}/${astroAsset}`, {
      headers: { "If-None-Match": etag },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const matching = await fetch(`${server.origin}/${astroAsset}`, {
      headers: { "If-Match": etag },
    });
    await matching.arrayBuffer();
    expect(matching.status).toBe(200);
    expect(matching.headers.get("cache-control")).toContain("immutable");
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

  const projectConf = {
    servingConfigPath: join(projectRoot, "deploy", "nginx-serving.conf"),
    securityHeadersPath: join(projectRoot, "deploy", "security-headers.conf"),
  } as const;

  const startInstance = async (options?: Parameters<typeof serveWithNginx>[5]) => {
    const nginxBinary = await ensureNginxRuntime();
    return serveWithNginx(
      nginxBinary,
      build.distRoot,
      projectConf.servingConfigPath,
      projectConf.securityHeadersPath,
      await findFreePort(),
      options,
    );
  };

  /**
   * 独立观测探针：不使用被测代码的任何归属/存活函数。
   * - 按 PGID（从实例句柄只取身份字段）直接查 ps；
   * - 用 lsof 确认监听端口的进程归属；
   * - 用 stat 确认目录存在性。
   */
  const independentGroupMembers = async (pgid: number): Promise<number[]> => {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,pgid,stat,command"]);
    const members: number[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const state = match[3] ?? "";
      if (
        Number(match[2]) === pgid &&
        !state.startsWith("Z") &&
        (match[4] ?? "").includes("nginx:")
      ) {
        members.push(Number(match[1]));
      }
    }
    return members;
  };

  const independentPortOwnerPgid = async (
    port: number,
  ): Promise<number[] | undefined> => {
    try {
      const { stdout } = await execFileAsync("lsof", [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-t",
      ]);
      const pids = stdout
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      if (pids.length === 0) return [];
      const owners: number[] = [];
      for (const pid of pids) {
        const { stdout: psOut } = await execFileAsync("ps", [
          "-p",
          String(pid),
          "-o",
          "pgid=",
        ]);
        owners.push(Number.parseInt(psOut.trim(), 10));
      }
      return owners;
    } catch {
      return undefined;
    }
  };

  /** 独立确认实例完全消失：进程组无成员、端口无本组监听、目录不存在。 */
  const assertIndependentlyGone = async (instance: {
    readonly instancePgid: number;
    readonly listenPort: number;
    readonly configDir: string;
  }): Promise<void> => {
    const members = await independentGroupMembers(instance.instancePgid);
    expect(
      members,
      `process group ${instance.instancePgid} still has live members: ${members.join(",")}`,
    ).toEqual([]);
    const portOwners = await independentPortOwnerPgid(instance.listenPort);
    expect(
      portOwners?.some((pgid) => pgid === instance.instancePgid) ?? false,
      `listen port ${instance.listenPort} still held by process group ${instance.instancePgid}`,
    ).toBe(false);
    await expect(stat(instance.configDir)).rejects.toThrow();
  };

  /** 独立确认实例仍在运行（master + worker + 端口 + 目录齐全）。 */
  const assertIndependentlyAlive = async (instance: NginxServer): Promise<void> => {
    const members = await independentGroupMembers(instance.instancePgid);
    expect(members.length, "instance must have live workers").toBeGreaterThan(0);
    const portOwners = await independentPortOwnerPgid(instance.listenPort);
    expect(
      portOwners?.some((pgid) => pgid === instance.instancePgid) ?? false,
      "listen port must be held by the instance process group",
    ).toBe(true);
    await expect(stat(instance.configDir)).resolves.toBeTruthy();
  };

  // =========================================================================
  // 故障类别 1：启动阶段各时点的失败（创建前/创建后/readiness 前/观测期）
  // =========================================================================

  it(
    "verifies spawn pid, pid file, and listener identity match, then stops cleanly",
    { timeout: 30_000 },
    async () => {
      const instance = await startInstance();
      let testError: unknown;
      try {
        const pidFile = await readFile(join(instance.configDir, "nginx.pid"), "utf8");
        expect(Number.parseInt(pidFile.trim(), 10)).toBe(instance.masterPid);
        const beforeStop = await fetch(`${instance.origin}/release.json`);
        expect(beforeStop.status).toBe(200);
        await assertIndependentlyAlive(instance);
        await instance.stop();
        expect(instance.state).toBe("cleaned");
        await assertIndependentlyGone(instance);
      } catch (error) {
        testError = error;
        throw error;
      } finally {
        if (testError !== undefined) {
          await instance.recover().catch((cleanupError: unknown) => {
            throw new AggregateError(
              [testError as Error, cleanupError as Error],
              "identity test failed and recovery failed",
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
        throw new Error("deliberate mid-test failure");
      } catch (error) {
        expect((error as Error).message).toContain("deliberate mid-test failure");
      } finally {
        await instance.stop();
      }
      await assertIndependentlyGone(instance);
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
    const snapshot = await nginxSnapshot();
    try {
      // nginx -t 失败发生在进程创建之前：目录必须被回收，无进程残留。
      await expect(
        serveWithNginx(
          nginxBinary,
          build.distRoot,
          brokenServing,
          brokenHeaders,
          await findFreePort(),
        ),
      ).rejects.toThrow(/exited with/);
      await assertNoNewNginxResidue(snapshot);
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });

  it("rejects an invalid binary at spawn and still cleans the configDir", async () => {
    const snapshot = await nginxSnapshot();
    // binary 不存在：spawn error 路径（进程创建失败），目录必须被删除。
    await expect(
      serveWithNginx(
        join(tmpdir(), "devhot-no-such-binary", "nginx"),
        build.distRoot,
        projectConf.servingConfigPath,
        projectConf.securityHeadersPath,
        await findFreePort(),
      ),
    ).rejects.toThrow();
    await assertNoNewNginxResidue(snapshot);
  });

  it(
    "fails startup when readiness never arrives and cleans up fully",
    { timeout: 60_000 },
    async () => {
      // readiness 之前的失败：端口被无关占位服务占用，nginx 绑定失败退出。
      const snapshot = await nginxSnapshot();
      const { createServer } = await import("node:http");
      const blocker = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("foreign placeholder");
      });
      await new Promise<void>((resolvePromise) =>
        blocker.listen(0, "127.0.0.1", () => resolvePromise()),
      );
      const blockedPort = (blocker.address() as { port: number }).port;
      try {
        const nginxBinary = await ensureNginxRuntime();
        const thrown = await serveWithNginx(
          nginxBinary,
          build.distRoot,
          projectConf.servingConfigPath,
          projectConf.securityHeadersPath,
          blockedPort,
        ).then(
          (instance) => {
            void instance;
            throw new Error("expected startup failure but instance started");
          },
          (error: unknown) => error as Error,
        );
        expect(thrown.message).toMatch(
          /did not become reachable|exited before readiness/,
        );
        await assertNoNewNginxResidue(snapshot);
        // 占位服务不受影响：仍正常响应。
        const probe = await fetch(`http://127.0.0.1:${blockedPort}/`);
        expect(probe.status).toBe(200);
      } finally {
        await new Promise<void>((resolvePromise) =>
          blocker.close(() => resolvePromise()),
        );
      }
    },
  );

  it(
    "fails startup when the identity observation fails and cleans up fully",
    { timeout: 60_000 },
    async () => {
      const snapshot = await nginxSnapshot();
      // 身份交叉验证观测失败：启动必须明确失败；清理身份来自创建语义，
      // 仍能终止组内全部进程并回收目录。
      const thrown = await startInstance({ failIdentityQuery: true }).then(
        (instance) => {
          void instance;
          throw new Error("expected startup failure but instance started");
        },
        (error: unknown) => error as Error,
      );
      expect(thrown.message).toMatch(/failed to verify process group of master pid \d+/);
      await assertNoNewNginxResidue(snapshot);
    },
  );

  it(
    "fails startup when the identity observation returns garbage and cleans up fully",
    { timeout: 60_000 },
    async () => {
      const snapshot = await nginxSnapshot();
      const thrown = await startInstance({ invalidIdentityOutput: true }).then(
        (instance) => {
          void instance;
          throw new Error("expected startup failure but instance started");
        },
        (error: unknown) => error as Error,
      );
      expect(thrown.message).toMatch(/invalid process group id output/);
      await assertNoNewNginxResidue(snapshot);
    },
  );

  it(
    "fails startup when the master exits during identity observation, with full cleanup",
    { timeout: 90_000 },
    async () => {
      const snapshot = await nginxSnapshot();
      // 确定性注入：身份交叉验证瞬间 SIGKILL master。孤儿 worker 只能靠
      // 创建语义的进程组身份追踪；启动被拒绝且清理完整。
      const thrown = await startInstance({
        killMasterDuringIdentityQuery: true,
      }).then(
        (instance) => {
          void instance;
          throw new Error("expected startup failure but instance started");
        },
        (error: unknown) => error as Error,
      );
      const messages =
        thrown instanceof AggregateError
          ? thrown.errors.map((error) => (error as Error).message)
          : [thrown.message];
      expect(
        messages.some((message) => /failed to verify process group|exited/.test(message)),
        JSON.stringify(messages),
      ).toBe(true);
      // 清理必须完整：不得只有身份错误而无收尾结果。
      expect(
        messages.some((message) =>
          /cleanup failed|could not confirm|still alive|survived/.test(message),
        ),
        JSON.stringify(messages),
      ).toBe(false);
      await assertNoNewNginxResidue(snapshot);
    },
  );

  // =========================================================================
  // 故障类别 2：master 正常/异常退出；worker 重建与孤儿
  // =========================================================================

  it(
    "cleans up orphan workers when the master crashes before stop()",
    { timeout: 60_000 },
    async () => {
      const instance = await startInstance();
      try {
        // 模拟 master 在 stop() 之前崩溃（外部 SIGKILL，不经 stop() 路径）。
        process.kill(instance.masterPid, "SIGKILL");
        await instance.stop();
        await assertIndependentlyGone(instance);
      } finally {
        await instance.recover();
      }
    },
  );

  it(
    "cleans up rebuilt orphan workers when the master crashes after a worker restart",
    { timeout: 90_000 },
    async () => {
      const instance = await startInstance();
      try {
        // 事件序列：终止初始 worker → master 重建替代 worker → 终止 master
        //（此时替代 worker 成为孤儿）→ stop() 必须终止替代 worker。
        const initialWorkers = (
          await independentGroupMembers(instance.instancePgid)
        ).filter((pid) => pid !== instance.masterPid);
        expect(initialWorkers.length).toBeGreaterThan(0);
        process.kill(initialWorkers[0]!, "SIGKILL");
        // 等待 master 重建替代 worker（新 PID，不在旧集合中）——确定性
        // 轮询等待状态转换完成，不以固定 sleep 掩盖竞态。
        let replacementWorkers: number[] = [];
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          replacementWorkers = (
            await independentGroupMembers(instance.instancePgid)
          ).filter((pid) => pid !== instance.masterPid && !initialWorkers.includes(pid));
          if (replacementWorkers.length > 0) break;
        }
        expect(
          replacementWorkers,
          "master must rebuild a replacement worker after the initial worker dies",
        ).not.toEqual([]);

        process.kill(instance.masterPid, "SIGKILL");
        await instance.stop();
        await assertIndependentlyGone(instance);
      } finally {
        await instance.recover();
      }
    },
  );

  // =========================================================================
  // 故障类别 3：TERM 无法处理 → 实际执行 KILL 升级并最终退出
  // =========================================================================

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
        await assertIndependentlyGone(instance);
      } finally {
        // 探针自身的独立兜底：恢复调度以防实现缺陷（SIGCONT 后排队的
        // 信号会生效），再走受控恢复。
        try {
          process.kill(instance.masterPid, "SIGCONT");
        } catch {
          // 已退出则无需恢复。
        }
        await instance.recover();
      }
    },
  );

  // =========================================================================
  // 故障类别 4：观测失效（查询失败/输出无效）→ 结果不得伪装成已退出
  // =========================================================================

  it(
    "reports cleanup failure rather than pretending success when group observation fails",
    { timeout: 60_000 },
    async () => {
      const instance = await startInstance({ failGroupEnumeration: true });
      // 观测失效：清理必须失败（UNKNOWN ≠ EXITED），不得误报成功。
      await expect(instance.stop()).rejects.toThrow(
        /could not enumerate process group|could not confirm/,
      );
      expect(instance.state).toBe("cleanup-failed");
      // 目录保留供诊断（I7）。
      await expect(stat(instance.configDir)).resolves.toBeTruthy();
      // 观测失效注入持续存在，recover() 也会失败（UNKNOWN ≠ EXITED），
      // 因此用独立外部终止完成收尾：ESRCH 表示组已不存在，同样视为
      // 已终止。这证明“清理失败”路径不伪装成功，且外部可安全恢复。
      try {
        try {
          process.kill(-instance.instancePgid, "SIGKILL");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        const members = await independentGroupMembers(instance.instancePgid);
        expect(members).toEqual([]);
        await rm(instance.configDir, { recursive: true, force: true });
      } finally {
        // 独立兜底：确保组与目录回收，避免测试自身制造残留。
        try {
          process.kill(-instance.instancePgid, "SIGKILL");
        } catch {
          // 组已不存在（ESRCH）。
        }
        await rm(instance.configDir, { recursive: true, force: true });
      }
    },
  );

  // =========================================================================
  // 故障类别 5：端口被无关服务占用/接管；无关服务不受影响
  // =========================================================================

  it(
    "coexists with an unrelated pre-existing nginx service",
    { timeout: 120_000 },
    async () => {
      // 先启动一个与测试无关的独立 Nginx（另一 configDir、另一端口、
      // 另一进程组），再执行身份观测失败用例：本实例失败收尾不得影响
      // 既有服务，断言也不得把既有进程当作本实例残留。
      const unrelated = await startInstance();
      try {
        await assertIndependentlyAlive(unrelated);
        const snapshot = await nginxSnapshot();
        const thrown = await startInstance({ failIdentityQuery: true }).then(
          (instance) => {
            void instance;
            throw new Error("expected startup failure but instance started");
          },
          (error: unknown) => error as Error,
        );
        expect(thrown.message).toMatch(
          /failed to verify process group of master pid \d+/,
        );
        // 失败实例无新增残留（既有服务仍在运行，因此不能用全机空集断言）。
        await assertNoNewNginxResidue(snapshot);
        // 既有服务不受影响：仍可响应、进程仍存活。
        const probe = await fetch(`${unrelated.origin}/release.json`);
        expect(probe.status).toBe(200);
        const stillAlive = await independentGroupMembers(unrelated.instancePgid);
        expect(stillAlive.length).toBeGreaterThan(0);
      } finally {
        await unrelated.stop();
        await assertIndependentlyGone(unrelated);
      }
    },
  );

  // =========================================================================
  // 故障类别 6：目录删除失败、重复 stop、并发 stop、失败后恢复
  // =========================================================================

  it(
    "fails loudly when the temp directory cannot be removed",
    { timeout: 30_000 },
    async () => {
      // 用注入的删除钩子确定性模拟 rm 失败（root 用户会绕过权限位，
      // 因此不能依赖 chmod）。
      const failures: string[] = [];
      const instance = await startInstance({
        removeConfigDir: async (path) => {
          failures.push(`simulated EACCES: ${path}`);
          throw new Error("EACCES: simulated permission failure");
        },
      });
      try {
        // stop() 必须失败且错误包含目录与实例身份；进程树仍被完整终止。
        await expect(instance.stop()).rejects.toThrow(/failed to remove/);
        expect(failures).toHaveLength(1);
        expect(instance.state).toBe("cleanup-failed");
        // 进程树已终止（目录保留）。
        const members = await independentGroupMembers(instance.instancePgid);
        expect(members).toEqual([]);
      } finally {
        // 失败后通过受控恢复入口还原真实删除，完成清理。
        await instance.recover();
      }
      await assertIndependentlyGone(instance);
    },
  );

  it(
    "resolves repeated and concurrent stop() calls with the same cleanup result",
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
        expect(instance.state).toBe("cleaned");
      } finally {
        // 若主体失败则确保清理；成功路径 recover() 幂等（不再发信号）。
        await instance.recover();
      }
      await assertIndependentlyGone(instance);
    },
  );

  it(
    "recovers after cleanup failure via the controlled recovery path",
    { timeout: 30_000 },
    async () => {
      // 先注入删除失败 → stop() 失败；再由外部恢复条件（真实删除）→
      // recover() 成功完成清理。恢复入口不依赖正常实例句柄路径。
      let removeShouldFail = true;
      const instance = await startInstance({
        removeConfigDir: async (path) => {
          if (removeShouldFail) {
            throw new Error("EACCES: simulated permission failure");
          }
          await rm(path, { recursive: true });
        },
      });
      try {
        await expect(instance.stop()).rejects.toThrow(/failed to remove/);
        expect(instance.state).toBe("cleanup-failed");
        // 目录仍保留供诊断。
        await expect(stat(instance.configDir)).resolves.toBeTruthy();
        // 外部条件恢复后走受控恢复入口。
        removeShouldFail = false;
        await instance.recover();
        expect(instance.state).toBe("cleaned");
      } finally {
        // 探针独立兜底：无论结果如何，确保组与目录回收。
        try {
          process.kill(-instance.instancePgid, "SIGKILL");
        } catch {
          // 组已退出。
        }
        await rm(instance.configDir, { recursive: true, force: true });
      }
      await assertIndependentlyGone(instance);
    },
  );

  it(
    "preserves both startup and cleanup errors when both fail",
    { timeout: 60_000 },
    async () => {
      // 启动失败（readiness 失败：端口被无关占位服务占用）+ 清理失败
      //（removeConfigDir 注入）：两类错误都必须保留在 AggregateError 中；
      // 且即使启动失败拿不到正常实例句柄，清理责任也不丢失。
      const { createServer } = await import("node:http");
      const blocker = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("foreign placeholder");
      });
      await new Promise<void>((resolvePromise) =>
        blocker.listen(0, "127.0.0.1", () => resolvePromise()),
      );
      const blockedPort = (blocker.address() as { port: number }).port;
      const snapshot = await nginxSnapshot();
      let thrown: unknown;
      try {
        thrown = await serveWithNginx(
          await ensureNginxRuntime(),
          build.distRoot,
          projectConf.servingConfigPath,
          projectConf.securityHeadersPath,
          blockedPort,
          {
            removeConfigDir: async () => {
              throw new Error("EACCES: simulated remove failure");
            },
          },
        ).then(
          (instance) => {
            void instance;
            return undefined;
          },
          (error: unknown) => error,
        );
      } finally {
        await new Promise<void>((resolvePromise) =>
          blocker.close(() => resolvePromise()),
        );
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      const messages = aggregate.errors.map((error) => (error as Error).message);
      expect(
        messages.some((message) =>
          /did not become reachable|exited before readiness|failed to verify/.test(
            message,
          ),
        ),
        `missing startup error in ${JSON.stringify(messages)}`,
      ).toBe(true);
      expect(
        messages.some((message) => /failed to remove|cleanup failed/.test(message)),
        `missing cleanup error in ${JSON.stringify(messages)}`,
      ).toBe(true);
      // 探针独立兜底：清理注入失败留下的目录（精确清理本次新增）。
      const after = await listConfDirs();
      const added = after.filter((dir) => !snapshot.dirs.includes(dir));
      for (const dir of added) {
        await rm(join(tmpdir(), dir), { recursive: true, force: true });
      }
    },
  );
});
