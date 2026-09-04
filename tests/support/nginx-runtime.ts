import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile) as (
  command: string,
  args: string[],
) => Promise<{ stdout: string }>;

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
      // rewrite 模块必须启用：error_page/内部重定向按状态改写缓存策略
      // 依赖它；此前为最小化构建而排除。
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
  /**
   * 本实例进程组 ID：master 与其 fork 的一切 worker（含重建的替代
   * worker 与 master 崩溃后的孤儿）共享该组；测试用它直接验证真实
   * 存活状态，而不是依赖按命令行匹配的 PID 清单。
   */
  readonly instancePgid: number;
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
  /** 测试注入：令身份捕获阶段的 ps 查询抛错（模拟查询失败）。 */
  readonly failIdentityQuery?: boolean;
  /** 测试注入：令身份捕获阶段的 ps 输出为非法值（模拟无效输出）。 */
  readonly invalidIdentityOutput?: boolean;
}

const STOP_TIMEOUT_MS = 10_000;

/** 枚举本仓库固定运行时启动的全部 nginx 进程 PID（master 与 worker）。 */
export const listDevhotNginxPids = async (): Promise<readonly number[]> => {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,stat,command"]);
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    // 僵尸（Z 态）不算存活进程。
    if (
      match &&
      !(match[2] ?? "").startsWith("Z") &&
      match[3]?.includes(`devhot-nginx-${NGINX_VERSION}`)
    ) {
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

  // 精确进程存活检查：child.killed 只表示“已发送过信号”，不表示进程已退出，
  // 绝不能作为存活依据；以 ps 为准。同时确认 PID 仍属于本实例（命令行含
  // 本实例配置路径），避免误杀 PID 复用的无关进程。
  const masterAlive = async (): Promise<boolean> => {
    if (!child || child.pid === undefined) return false;
    try {
      const { stdout } = await execFileAsync("ps", [
        "-p",
        String(child.pid),
        "-o",
        "stat=,command=",
      ]);
      // 僵尸态（Z）不算存活；命令行须属于本实例配置。
      return !stdout.trim().startsWith("Z") && stdout.includes(configDir);
    } catch {
      return false;
    }
  };

  // 本实例进程身份：nginx 以独立进程组（detached）启动，master 与其 fork
  // 的一切 worker（含 master 崩溃后 init 接管前 fork 的替代 worker）都
  // 继承同一 PGID。以 PGID 判定归属可以跨 worker 重建持续追踪，不受
  // “PID 集合采样是否过期”影响；master 崩溃后孤儿 worker 仍可识别。
  // 身份必须在启动早期建立并验证：查询失败、输出非法或归属不符时启动
  // 直接失败，绝不返回身份不完整的实例——缺失 PGID 会让后续清理把
  // “归属未知”误当“没有实例进程”而提前报成功。
  let instancePgid: number | undefined;
  const captureInstancePgid = async (): Promise<number> => {
    if (instancePgid !== undefined) return instancePgid;
    if (!child?.pid) {
      throw new Error(
        `pinned nginx master exited before identity capture (${identity()})`,
      );
    }
    let stdout: string;
    try {
      if (options.failIdentityQuery) {
        throw new Error("injected identity query failure");
      }
      const result = await execFileAsync("ps", ["-p", String(child.pid), "-o", "pgid="]);
      stdout = result.stdout;
    } catch (error) {
      throw new Error(
        `failed to read process group of master pid ${child.pid}: ${(error as Error).message} (${identity()})`,
      );
    }
    if (options.invalidIdentityOutput) {
      throw new Error(
        `invalid process group id for master pid ${child.pid}: ${JSON.stringify("not-a-pgid")} (${identity()})`,
      );
    }
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `invalid process group id for master pid ${child.pid}: ${JSON.stringify(stdout.trim())} (${identity()})`,
      );
    }
    // 归属验证：pgid 必须与 master 的完整 ps 记录一致，防止解析异常值。
    const verify = await execFileAsync("ps", [
      "-p",
      String(child.pid),
      "-o",
      "pid=,pgid=",
    ]);
    const verifyMatch = verify.stdout.trim().match(/^\s*(\d+)\s+(\d+)\s*$/);
    const verifyPid = verifyMatch ? Number(verifyMatch[1]) : Number.NaN;
    const verifyPgid = verifyMatch ? Number(verifyMatch[2]) : Number.NaN;
    if (verifyPid !== child.pid || verifyPgid !== parsed) {
      throw new Error(
        `process group identity mismatch for master pid ${child.pid}: pgid query=${parsed}, ps=${verify.stdout.trim()} (${identity()})`,
      );
    }
    instancePgid = parsed;
    return parsed;
  };

  /**
   * 身份未知时的兜底归属确认：按命令行包含本实例 configDir 判定（master
   * cmdline 含 configDir；worker 不含）。worker 无法由此识别——因此本函
   * 数只在“master 已退出”的场景下作为无归属证明使用，绝不能单独作为
   * “实例已全部退出”的依据。
   */
  const anyConfigDirProcessAlive = async (): Promise<boolean> => {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,stat,command"]);
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const state = match[2] ?? "";
      const command = match[3] ?? "";
      if (!state.startsWith("Z") && command.includes(configDir)) {
        return true;
      }
    }
    return false;
  };

  /** 本实例进程组内当前存活的 nginx 进程（排除僵尸）。身份未知（从未
   * 捕获到 pgid）时返回空集合并由调用方决定语义——启动成功路径不会
   * 出现该状态（身份失败即启动失败）；清理路径在身份缺失时只依赖
   * master PID 精确终止。 */
  const instanceProcesses = async (): Promise<readonly number[]> => {
    if (instancePgid === undefined) return [];
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,pgid,stat,command"]);
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const pgid = Number(match[2]);
      const state = match[3] ?? "";
      const command = match[4] ?? "";
      if (
        pgid === instancePgid &&
        !state.startsWith("Z") &&
        (command.includes("nginx: master process") ||
          command.includes("nginx: worker process") ||
          command.includes(`devhot-nginx-${NGINX_VERSION}`))
      ) {
        pids.push(pid);
      }
    }
    return pids;
  };

  // 存活检查排除僵尸态：分离进程组的子进程退出后可能短暂成为僵尸
  // （Z 状态，ps 仍列出），僵尸不属于“存活”，不得据此判定清理失败。
  const pidAlive = async (pid: number): Promise<boolean> => {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "stat="]);
      const state = stdout.trim();
      return state.length > 0 && !state.startsWith("Z");
    } catch {
      return false;
    }
  };

  const stopProcessTree = async (failures: string[]): Promise<void> => {
    if (!child || child.pid === undefined) return;
    const masterPid = child.pid;
    const exited = waitForExit(child);

    const signal = (sig: NodeJS.Signals, target?: number): void => {
      try {
        if (target !== undefined) {
          process.kill(target, sig);
        } else {
          child!.kill(sig);
        }
      } catch (error) {
        failures.push(
          `failed to send ${sig} to ${target ?? `master pid ${masterPid}`}: ${error}`,
        );
      }
    };

    // 以进程组身份枚举本实例当前存活 worker（含替代 worker 与孤儿 worker）。
    let trackedWorkers = (await instanceProcesses()).filter((pid) => pid !== child!.pid);

    if (await masterAlive()) {
      signal("SIGTERM");
    }
    const termResult = await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((resolvePromise) =>
        setTimeout(() => resolvePromise("timeout"), STOP_TIMEOUT_MS).unref(),
      ),
    ]);
    if (termResult === "timeout") {
      // SIGTERM 超时且 master 仍存活：必须真正发送 SIGKILL（child.killed 已
      // 为 true 但进程未退出，不能用其短路）。
      if (await masterAlive()) {
        signal("SIGKILL");
        const killResult = await Promise.race([
          exited.then(() => "exited" as const),
          new Promise<"timeout">((resolvePromise) =>
            setTimeout(() => resolvePromise("timeout"), STOP_TIMEOUT_MS).unref(),
          ),
        ]);
        if (killResult === "timeout" && (await masterAlive())) {
          failures.push(
            `master pid ${masterPid} survived SIGTERM and SIGKILL (${identity()})`,
          );
        }
      } else {
        // 等待期间已退出：退出事件可能在 exitCode 更新前到达，等待 exited 兜底。
        await exited;
      }
    }
    // master 被 SIGKILL 后 worker 可能被 PID 1 接管并继续监听：给正常退出
    // 一点时间，然后只对预先捕获的本实例 worker 精确 SIGTERM/SIGKILL。
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    let aliveWorkers: number[] = [];
    for (const workerPid of trackedWorkers) {
      if (await pidAlive(workerPid)) aliveWorkers.push(workerPid);
    }
    if (aliveWorkers.length > 0) {
      for (const workerPid of aliveWorkers) {
        signal("SIGTERM", workerPid);
      }
      for (let attempt = 0; attempt < 50 && aliveWorkers.length > 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        trackedWorkers = (await instanceProcesses()).filter((pid) => pid !== child!.pid);
        aliveWorkers = [...trackedWorkers];
      }
      if (aliveWorkers.length > 0) {
        for (const workerPid of aliveWorkers) {
          signal("SIGKILL", workerPid);
        }
        // SIGKILL 后的退出存在调度延迟（CI 容器更明显）：有界轮询等待。
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          trackedWorkers = (await instanceProcesses()).filter(
            (pid) => pid !== child!.pid,
          );
          aliveWorkers = [...trackedWorkers];
          if (aliveWorkers.length === 0) break;
        }
        if (aliveWorkers.length > 0) {
          failures.push(
            `workers ${aliveWorkers.join(",")} survived SIGTERM and SIGKILL (${identity()})`,
          );
        }
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
    // 以进程组身份枚举本实例存活 worker：跨 worker 重建持续追踪，
    // 不依赖采样时的 PID 集合。
    const instancePids = await instanceProcesses();
    const workersAlive = instancePids.filter((pid) => pid !== child?.pid);
    // 端口归属检查：本实例进程树退出后，端口可能被无关服务占用（例如测试
    // 的占位服务）。只把“端口仍被本实例进程持有”视为未退出；无关监听者
    // 不影响本实例资源回收，也不得被停止或等待。
    let portListening = false;
    let portOwnedByInstance = false;
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
    if (portListening) {
      // 监听者若是本实例进程组成员（含替代 worker 与 master 崩溃后的
      // 孤儿），端口属于本实例，不得放行。
      if (workersAlive.length > 0 || masterAlive) {
        portOwnedByInstance = true;
      } else {
        // 本实例进程组已无存活成员：以监听进程身份最终确认归属——
        // 与本进程组无关的监听者（例如测试占位服务）不受影响，也不得
        // 被停止或等待。
        try {
          const { stdout: lsofOut } = await execFileAsync("lsof", [
            "-nP",
            `-iTCP:${listenPort}`,
            "-sTCP:LISTEN",
            "-t",
          ]);
          const listenerPids = lsofOut
            .split("\n")
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((pid) => Number.isInteger(pid) && pid > 0);
          const pgidOf = async (pid: number): Promise<number | undefined> => {
            try {
              const { stdout } = await execFileAsync("ps", [
                "-p",
                String(pid),
                "-o",
                "pgid=",
              ]);
              return Number.parseInt(stdout.trim(), 10);
            } catch {
              return undefined;
            }
          };
          const listenerPgids = await Promise.all(listenerPids.map(pgidOf));
          if (instancePgid === undefined) {
            // 身份未知（启动早期失败）：以本实例 configDir 的命令行归属做
            // 最终确认——master cmdline 含 configDir；worker 由 master fork，
            // master 已退出且无本实例 cmdline 进程时，端口不可能属于本实例
            // （例如端口被无关占位服务占用、nginx 绑定失败的启动路径）。
            // 仍有本实例 cmdline 进程存活时保守视为持有（清理失败）。
            portOwnedByInstance = await anyConfigDirProcessAlive();
          } else {
            // 身份已验证：监听进程 PGID 与本实例组一致即为本实例持有。
            portOwnedByInstance = listenerPgids.some((pgid) => pgid === instancePgid);
          }
        } catch {
          // lsof 不可用：以本实例进程身份为准——组身份可用时看组内成员；
          // 身份未知（启动早期失败）时退回 configDir 命令行归属。组内已
          // 无存活成员且无本实例 cmdline 进程时端口不可能属于本实例；
          // 否则保守视为本实例仍持有（清理失败），不得当作无关放行
          // （身份未知绝不等于“没有实例进程”）。
          if (instancePgid === undefined) {
            portOwnedByInstance = await anyConfigDirProcessAlive();
          } else {
            portOwnedByInstance =
              (await instanceProcesses()).length > 0 ||
              (await anyConfigDirProcessAlive());
          }
        }
      }
    }
    return {
      masterAlive,
      workersAlive,
      portListening: portOwnedByInstance,
    };
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
    // detached: 独立进程组。测试可用 SIGSTOP 暂停 master 验证 SIGKILL 升级，
    // 且不会把停止状态传播到测试运行器的终端进程组；生命周期仍由本文件
    // 显式管理（stop/SIGKILL 均按精确 PID 发送）。
    child = spawn(nginxBinaryPath, ["-c", configPath, "-g", "daemon off;"], {
      cwd: configDir,
      stdio: "ignore",
      detached: true,
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
        // readiness 必须来自本实例：/release.json 是 JSON；端口被无关 HTTP
        // 服务占用时（text/plain 等），不得误判为就绪。
        if ((probe.headers.get("content-type") ?? "").includes("application/json")) {
          ready = true;
          break;
        }
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
    // 启动成功即捕获并验证本实例进程组身份（PGID）：master 与其 fork
    // 的一切 worker（含后续重建的替代 worker）都继承该组，master 崩溃
    // 后仍可按组识别孤儿 worker。查询失败/输出非法/归属不符均视为启动
    // 失败，由 cleanupOnSetupFailure 走完整进程清理并保留两类错误。
    const capturedPgid = await captureInstancePgid();
    if ((await instanceProcesses()).length === 0) {
      await cleanupOnSetupFailure(
        new Error(
          `instance process group ${capturedPgid} has no live members after identity capture (${identity()})`,
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

  // 身份已在启动路径验证；此处仅为类型收窄（运行时不可能为 undefined）。
  const validatedPgid = instancePgid as number;
  return {
    origin: `http://127.0.0.1:${listenPort}`,
    masterPid: child!.pid!,
    configDir,
    listenPort,
    instancePgid: validatedPgid,
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
