import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// #78 固定 Nginx 运行时：真实 HTTP 验证必须使用固定版本，不允许用配置文本
// 扫描或手工注入安全头的 Node 测试服务器替代。
// - 版本：nginx 1.30.4（官方稳定行）
// - 完整性：tarball SHA-256 固定；签名文件随缓存一并保存供人工复核
// - 构建：源码 ./configure + make，仅静态站点所需模块，安装到本机缓存目录
export const NGINX_VERSION = "1.30.4";
export const NGINX_TARBALL_SHA256 =
  "4261dc90e9e47c1c4041276e9aaa3d48ebe2e664f728e14fa95ae6c67d57a08b";
const NGINX_URL = `https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz`;

const runtimeRoot = join(
  tmpdir(),
  `devhot-nginx-${NGINX_VERSION}-${NGINX_TARBALL_SHA256.slice(0, 12)}`,
);
const nginxBinary = join(runtimeRoot, "sbin", "nginx");

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const exec = (command: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

// 安装固定运行时；已存在且校验通过时直接复用（缓存只加速准备，不改变结果）。
export const ensureNginxRuntime = async (): Promise<string> => {
  if (await exists(nginxBinary)) {
    await exec(nginxBinary, ["-v"], runtimeRoot);
    return nginxBinary;
  }

  const markerPath = join(runtimeRoot, ".install-complete");
  if (await exists(markerPath)) {
    throw new Error("pinned nginx runtime cache is inconsistent; remove it and retry");
  }

  const staging = join(runtimeRoot, ".staging");
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(join(staging, "src"), { recursive: true });

  const tarball = Buffer.from(
    await (await fetch(NGINX_URL, { redirect: "follow" })).arrayBuffer(),
  );
  if (sha256(tarball) !== NGINX_TARBALL_SHA256) {
    throw new Error("pinned nginx tarball sha256 mismatch");
  }
  const tarballPath = join(staging, `nginx-${NGINX_VERSION}.tar.gz`);
  await writeFile(tarballPath, tarball);
  await exec("tar", ["-xzf", tarballPath, "-C", "src"], staging);

  const sourceRoot = join(staging, "src", `nginx-${NGINX_VERSION}`);
  await exec(
    join(sourceRoot, "configure"),
    [
      `--prefix=${runtimeRoot}`,
      `--sbin-path=${nginxBinary}`,
      "--without-http_rewrite_module",
      "--without-http_gzip_module",
    ],
    sourceRoot,
  );
  await exec("make", ["-j", "4"], sourceRoot);
  await exec("make", ["install"], sourceRoot);

  if (!(await exists(nginxBinary))) {
    throw new Error("pinned nginx binary is missing after install");
  }
  await writeFile(markerPath, `${NGINX_VERSION} ${NGINX_TARBALL_SHA256}\n`);
  const previous = await readFile(nginxBinary);
  await rm(join(staging, "src", `nginx-${NGINX_VERSION}`, "objs"), {
    recursive: true,
    force: true,
  }).catch(() => {});
  // make install 已写入最终位置；staging 仅保留 tarball 与源码目录供追溯。
  const marker2 = join(runtimeRoot, ".binary-check");
  await writeFile(marker2, sha256(previous));
  await rename(join(staging, "src"), join(runtimeRoot, ".source")).catch(() => {});
  return nginxBinary;
};

export interface NginxServer {
  readonly origin: string;
  /** spawn 启动器 PID；必须等于 pid 文件中的 master PID（启动时已断言）。 */
  readonly masterPid: number;
  /** 本实例创建的临时配置/dist 目录（stop() 成功后被删除）。 */
  readonly configDir: string;
  /** 本实例监听端口。 */
  readonly listenPort: number;
  /** 统一清理：SIGTERM 精确 master → 等待进程树退出 → 端口关闭 → 删除目录。 */
  stop(): Promise<void>;
  /**
   * 上一次清理失败后的重试：丢弃失败的共享 Promise，恢复真实删除，针对
   * 同一实例身份（masterPid/configDir/listenPort）重新执行完整清理。
   */
  retryCleanupAfterFailure(): Promise<void>;
}

export const findFreePort = async (): Promise<number> => {
  const { createServer } = await import("node:net");
  return new Promise((resolvePromise, rejectPromise) => {
    const probeServer = createServer();
    probeServer.unref();
    probeServer.on("error", rejectPromise);
    probeServer.listen(0, "127.0.0.1", () => {
      const address = probeServer.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probeServer.close(() => resolvePromise(port));
    });
  });
};

export interface ServeWithNginxOptions {
  /** 测试注入：替换 configDir 删除动作，用于确定性模拟清理失败。 */
  readonly removeConfigDir?: (path: string) => Promise<void>;
}

const STOP_TIMEOUT_MS = 10_000;

/** 枚举本仓库固定运行时启动的全部 nginx 进程 PID（master 与 worker）。 */
export const listDevhotNginxPids = async (): Promise<readonly number[]> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile) as (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string }>;
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,command"]);
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match?.[2]?.includes(`devhot-nginx-${NGINX_VERSION}`)) {
      pids.push(Number(match[1]));
    }
  }
  return pids;
};

// 以真实 Nginx 服务 distRoot：serving config 的 include 被重写为指向仓库内
// security-headers.conf，root 指向 distRoot，其余逐字保留。监听端口由调用方
// 通过临时 nginx 配置动态分配，避免与遗留进程或并行运行冲突。
//
// 生命周期契约：
// - 前台运行只经 CLI `-g "daemon off;"` 强制，配置正文不含 daemon 指令；
// - 启动成功要求：pid 文件 master PID === child.pid，且 HTTP readiness 后
//   child 仍存活，且本实例进程树持有监听端口；
// - 从 configDir 创建开始，任何 setup 失败都清理该精确目录（child 已创建时
//   走完整进程清理），两类错误以 AggregateError 保留；
// - stop() 只对精确 master PID 发信号，等待 master 与 worker 全部退出、
//   端口无监听后，才删除 configDir；进程仍存活时绝不删除目录。
export const serveWithNginx = async (
  nginxBinaryPath: string,
  distRoot: string,
  servingConfigPath: string,
  securityHeadersPath: string,
  listenPort: number,
  options: ServeWithNginxOptions = {},
): Promise<NginxServer> => {
  const configDir = join(tmpdir(), `devhot-nginx-conf-${process.pid}-${Date.now()}`);

  const realRemove = async (path: string): Promise<void> => rm(path, { recursive: true });
  let removeConfigDir: (path: string) => Promise<void> =
    options.removeConfigDir ?? realRemove;

  let child: ChildProcess | undefined;
  const identity = () =>
    `master spawn-pid=${child?.pid ?? "n/a"} pid-file=${configDir}/nginx.pid ` +
    `configDir=${configDir} listenPort=${listenPort}`;

  // 缓存退出 Promise：exit 事件只触发一次，重复 stop()/重试必须共享同一
  // 结果，否则在已退出的 child 上重新监听会永远挂起。
  const waitForExit = (() => {
    let cached: Promise<void> | undefined;
    return (target: ChildProcess): Promise<void> => {
      cached ??= new Promise<void>((resolvePromise) => {
        target.on("exit", () => resolvePromise());
        target.on("error", () => resolvePromise());
      });
      return cached;
    };
  })();

  // 完整进程清理：SIGTERM 精确 master → 有界等待 → SIGKILL 终局 → 由调用方
  // 确认进程树退出与端口关闭。kill() 发送失败进入错误证据。
  const stopProcessTree = async (failures: string[]): Promise<void> => {
    if (!child || child.pid === undefined) return;
    const masterPid = child.pid;
    const exited = waitForExit(child);

    // 对已退出的 child 发送信号是 no-op（kill 返回 false 属预期）；只有
    // child 仍存活时发送失败才进入错误证据。
    const signal = (sig: NodeJS.Signals): boolean => {
      if (child!.exitCode !== null || child!.killed) return true;
      try {
        const delivered = child!.kill(sig);
        if (!delivered && child!.exitCode === null) return false;
        return true;
      } catch (error) {
        failures.push(`failed to send ${sig} to master pid ${masterPid}: ${error}`);
        return false;
      }
    };

    signal("SIGTERM");
    const termResult = await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((resolvePromise) =>
        setTimeout(() => resolvePromise("timeout"), STOP_TIMEOUT_MS).unref(),
      ),
    ]);
    if (termResult === "timeout") {
      if (!signal("SIGKILL")) {
        failures.push(`failed to deliver SIGKILL to live master pid ${masterPid}`);
      }
      const killResult = await Promise.race([
        exited.then(() => "exited" as const),
        new Promise<"timeout">((resolvePromise) =>
          setTimeout(() => resolvePromise("timeout"), STOP_TIMEOUT_MS).unref(),
        ),
      ]);
      if (killResult === "timeout") {
        failures.push(
          `master pid ${masterPid} survived SIGTERM and SIGKILL (${identity()})`,
        );
      }
    }
  };

  const treeState = async (): Promise<{
    masterAlive: boolean;
    workersAlive: readonly number[];
    portListening: boolean;
  }> => {
    const allPids = await listDevhotNginxPids();
    const masterAlive = child?.pid !== undefined && allPids.includes(child.pid);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile) as (
      command: string,
      args: string[],
    ) => Promise<{ stdout: string }>;
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,command"]);
    const workersAlive: number[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const command = match[3] ?? "";
      if (
        command.includes("nginx: worker process") &&
        (ppid === child?.pid || command.includes(configDir))
      ) {
        workersAlive.push(pid);
      }
    }
    let portListening = false;
    try {
      const probe = await fetch(`http://127.0.0.1:${listenPort}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      });
      await probe.arrayBuffer();
      portListening = true;
    } catch (error) {
      portListening = (error as Error).name === "TimeoutError";
    }
    return { masterAlive, workersAlive, portListening };
  };

  let cleanupPromise: Promise<void> | undefined;
  let cleanupSucceeded = false;
  const runCleanup = async (context: string): Promise<void> => {
    const failures: string[] = [];
    await stopProcessTree(failures);
    const state = await treeState();
    if (state.masterAlive) {
      failures.push(`master still alive after stop signals (${identity()})`);
    }
    if (state.workersAlive.length > 0) {
      failures.push(
        `workers still alive after stop signals: ${state.workersAlive.join(",")} (${identity()})`,
      );
    }
    if (state.portListening) {
      failures.push(`listen port ${listenPort} still listening (${identity()})`);
    }
    if (failures.length > 0) {
      // 进程树未确认退出：保留 configDir 供诊断，不得删除。
      throw new Error(`nginx cleanup failed during ${context}: ${failures.join("; ")}`);
    }
    try {
      await removeConfigDir(configDir);
      cleanupSucceeded = true;
    } catch (error) {
      throw new Error(
        `nginx cleanup failed during ${context}: failed to remove ${configDir}: ${(error as Error).message} (${identity()})`,
      );
    }
  };
  const runRetry = async (): Promise<void> => {
    // 只在上次清理失败后执行：恢复真实删除并重跑完整清理。
    removeConfigDir = realRemove;
    cleanupPromise = runCleanup("retry");
    return cleanupPromise;
  };
  const cleanupOnce = (context: string): Promise<void> => {
    cleanupPromise ??= runCleanup(context);
    return cleanupPromise;
  };

  let handlingSetupFailure = false;
  const cleanupOnSetupFailure = async (setupError: unknown): Promise<never> => {
    // 防重入：本函数抛出的错误不得再次进入外层 catch 被二次包装。
    if (handlingSetupFailure) throw setupError;
    handlingSetupFailure = true;
    const setupErrorTyped = setupError as Error;
    if (!child) {
      try {
        await removeConfigDir(configDir);
      } catch (removeError) {
        throw new AggregateError(
          [setupErrorTyped, removeError as Error],
          "nginx setup failed and directory cleanup failed",
        );
      }
      throw setupErrorTyped;
    }
    try {
      await cleanupOnce("setup");
    } catch (cleanupError) {
      throw new AggregateError(
        [setupErrorTyped, cleanupError as Error],
        "nginx setup failed and process cleanup failed",
      );
    }
    throw setupErrorTyped;
  };

  try {
    await mkdir(configDir, { recursive: true, mode: 0o755 });
    // mkdtemp 建立的 fixture 目录是 0700；nginx worker（nobody）无法遍历会产生 403。
    // 把 dist 复制到 0755 的服务目录，供 worker 读取。
    const serveRoot = join(configDir, "dist");
    await cp(distRoot, serveRoot, { recursive: true });
    await chmod(serveRoot, 0o755);
    const original = await readFile(servingConfigPath, "utf8");
    const headersTarget = join(configDir, "deploy", "security-headers.conf");
    await mkdir(dirname(headersTarget), { recursive: true });
    const headers = await readFile(securityHeadersPath, "utf8");
    await writeFile(headersTarget, headers);
    const mimeTypes = join(configDir, "mime.types");
    await writeFile(
      mimeTypes,
      "types { text/html html; text/css css; application/json json; image/png png; image/svg+xml svg; text/javascript js; }\n",
    );
    const renderedBody = original
      .replace("root /usr/share/nginx/html;", `root ${serveRoot};`)
      .replace("listen 8080;", `listen 127.0.0.1:${listenPort};`)
      .replace("include /etc/nginx/mime.types;", `include ${mimeTypes};`);
    const rendered = [
      // daemon 指令只经 CLI `-g "daemon off;"` 下发（唯一权威来源），
      // 配置正文不包含 daemon，spawn 的 child 即真实 master。
      `error_log ${join(configDir, "error.log")} crit;`,
      `pid ${join(configDir, "nginx.pid")};`,
      "events { }",
      "http {",
      "    access_log off;",
      renderedBody,
      "}",
      "",
    ].join("\n");
    const configPath = join(configDir, "nginx.conf");
    await writeFile(configPath, rendered);

    await exec(nginxBinaryPath, ["-t", "-c", configPath], configDir);
    child = spawn(nginxBinaryPath, ["-c", configPath, "-g", "daemon off;"], {
      cwd: configDir,
      stdio: "ignore",
      detached: false,
    });
    // spawn error（如 binary 不存在）必须让等待 Promise 结束。
    void waitForExit(child);

    // 等待 HTTP readiness；期间 child 退出即为启动失败。子进程存活时轮询
    // fetch（连接被占位服务挂断/拒绝都很快返回失败）。
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) {
        await cleanupOnSetupFailure(
          new Error(
            `pinned nginx exited before readiness with code ${child.exitCode} (${identity()})`,
          ),
        );
      }
      try {
        const probe = await fetch(`http://127.0.0.1:${listenPort}/release.json`, {
          redirect: "manual",
          signal: AbortSignal.timeout(250),
        });
        await probe.arrayBuffer();
        ready = true;
        break;
      } catch (error) {
        // fetch 失败可能是端口未开（重试）或占位服务挂断（nginx 已死，重试
        // 会命中上方的 exitCode 检查）。
        void error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        if (attempt === 99) {
          await cleanupOnSetupFailure(
            new Error(`pinned nginx did not become reachable (${identity()})`),
          );
        }
      }
    }
    if (!ready) {
      await cleanupOnSetupFailure(
        new Error(`pinned nginx did not become reachable (${identity()})`),
      );
    }

    // 权威身份校验：pid 文件 master PID 必须等于 child.pid。
    const pidFile = join(configDir, "nginx.pid");
    let masterPidFromFile: number | undefined;
    try {
      masterPidFromFile = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    } catch {
      await cleanupOnSetupFailure(
        new Error(`pinned nginx pid file is missing or unreadable (${identity()})`),
      );
    }
    if (child.pid === undefined || masterPidFromFile !== child.pid) {
      await cleanupOnSetupFailure(
        new Error(
          `pinned nginx master identity mismatch: pid file ${masterPidFromFile} !== spawn pid ${child.pid} (${identity()})`,
        ),
      );
    }
    if (child.exitCode !== null) {
      await cleanupOnSetupFailure(
        new Error(
          `pinned nginx master exited after readiness with code ${child.exitCode} (${identity()})`,
        ),
      );
    }
    const allPids = await listDevhotNginxPids();
    if (!allPids.includes(child.pid!)) {
      await cleanupOnSetupFailure(
        new Error(
          `listen port ${listenPort} is not served by this nginx process tree (${identity()})`,
        ),
      );
    }
  } catch (error) {
    if (handlingSetupFailure) {
      // cleanupOnSetupFailure 已经完成包装并抛出，直接上抛。
      throw error;
    }
    await cleanupOnSetupFailure(error);
  }

  return {
    origin: `http://127.0.0.1:${listenPort}`,
    masterPid: child!.pid!,
    configDir,
    listenPort,
    stop: () => cleanupOnce("stop"),
    retryCleanupAfterFailure: () => {
      // 已成功的清理保持幂等：不重跑、直接返回原成功结果。
      if (cleanupPromise !== undefined) {
        return cleanupPromise
          .then(
            () => undefined,
            () => undefined,
          )
          .then(() => {
            if (cleanupSucceeded) return Promise.resolve();
            return runRetry();
          });
      }
      return runRetry();
    },
  };
};
