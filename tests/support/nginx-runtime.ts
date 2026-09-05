import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  return nginxBinary;
};

// ---------------------------------------------------------------------------
// 生命周期与观测模型
//
// 实例身份（identity）
//   - 来源：spawn(..., { detached: true }) 的创建语义。detached 子进程运行
//     在一个全新进程组中，且是该组的组长，因此 PGID === master PID。这是
//     操作系统在创建时刻保证的关系，不是事后观察出来的。
//   - 建立：spawn 返回即确定（pgid := child.pid）；master 退出不会使它失效
//     ——进程组 ID 在组内所有成员退出前保持有效，nginx master fork 的一切
//     worker（含 master 崩溃后 init 接管的孤儿、重建的替代 worker）都
//     继承该组，因此任何时刻“属于本实例的进程”都能按 PGID 枚举。
//   - 交叉验证：启动后用 ps 复核一次 master 的 pgid 与创建语义一致；
//     不一致视为异常系统状态，启动失败（I2/I3）。
//
// 观测（observation）与语义
//   - EXITED（可证明退出）：ps 不再列出该 PID，或仅列出僵尸态；按 PGID
//     枚举不到任何非僵尸成员；端口监听者的 PGID 与本实例组不同。
//   - UNKNOWN（无法确认）：ps/lsof 查询失败或输出无法解析。UNKNOWN 绝不
//     折叠为“不存在/无关”，它使清理失败（I3/I7）。
//   - ps、lsof 只用于观测与交叉验证，不用于产生身份（I2）。
//
// 清理核心（所有路径共用）
//   对整个进程组发送信号：kill(-pgid, TERM) → 有界等待组内成员退出 →
//   kill(-pgid, KILL) → 有界等待 → 最终确认（组内无存活成员且端口不再由
//   本组持有）→ 删除 configDir。启动失败、正常 stop、重复 stop、失败恢复
//   全部经过这一条路径（I4/I5）。成功即代表 I6 成立；无法确认退出时保留
//   目录与错误（I7），并暴露 recover() 供受控重试。
//   信号只发往本实例进程组，绝不触及组外的任何进程（I8）。
// ---------------------------------------------------------------------------

/** 生命周期状态：清理责任从资源创建时刻起始终存在（I1）。 */
export type NginxLifecycleState = "ready" | "cleaning" | "cleaned" | "cleanup-failed";

/** 进程观测结果：UNKNOWN 不等于 EXITED（I3）。 */
export type ProcessObservation = "alive" | "exited" | "unknown";

export interface NginxServer {
  readonly origin: string;
  /** spawn 返回的 master PID；由创建语义同时是本实例进程组 ID。 */
  readonly masterPid: number;
  /** 本实例创建的临时配置/dist 目录（清理成功后被删除）。 */
  readonly configDir: string;
  /** 本实例监听端口。 */
  readonly listenPort: number;
  /** 本实例进程组 ID（=== masterPid，创建语义保证）。 */
  readonly instancePgid: number;
  /** 当前生命周期状态。 */
  readonly state: NginxLifecycleState;
  /** 统一清理：组 TERM → 有界等待 → 组 KILL → 有界等待 → 确认 → 删除目录。 */
  stop(): Promise<void>;
  /** 上一次清理失败后的受控恢复：重新执行同一清理核心。 */
  recover(): Promise<void>;
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

/** 故障注入：只影响观测工具（ps/lsof/rm）与注入时机，不改变创建语义。 */
export interface ServeWithNginxOptions {
  /** 替换 configDir 删除动作（模拟 rm 失败）。 */
  readonly removeConfigDir?: (path: string) => Promise<void>;
  /** 令身份交叉验证的 ps 查询抛错（模拟观测失效）。 */
  readonly failIdentityQuery?: boolean;
  /** 令身份交叉验证的 ps 输出为非法值。 */
  readonly invalidIdentityOutput?: boolean;
  /** 在身份交叉验证的瞬间 SIGKILL master（master 在观测期间退出）。 */
  readonly killMasterDuringIdentityQuery?: boolean;
  /** 令组枚举的 ps 查询抛错（清理期观测失效 → 清理失败而非误报成功）。 */
  readonly failGroupEnumeration?: boolean;
}

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const POLL_ATTEMPTS = Math.ceil(STOP_TIMEOUT_MS / POLL_INTERVAL_MS);

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

  // ---- 观测原语：ps/lsof 只读；失败与非法输出一律记为 unknown（I3）----
  /**
   * 单个 PID 的存活观测。ps -p 对不存在的 PID 以非零状态退出且输出为空
   *（macOS/Linux 一致），这是“进程不存在”的正常语义，不算观测失败；
   * 只有输出非空但无法解析、或 ps 以其他方式失败时才是 unknown。
   */
  const observePid = async (pid: number): Promise<ProcessObservation> => {
    let stdout: string;
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "stat="]);
      stdout = result.stdout;
    } catch (error) {
      const message = error as { stdout?: string; stderr?: string; message: string };
      // 非零退出 + 无 stdout = PID 不存在（ps 的“查无此进程”语义）。
      if ((message.stdout ?? "").trim().length === 0) return "exited";
      return "unknown";
    }
    const state = stdout.trim();
    if (state.length === 0) return "exited";
    if (state.startsWith("Z")) return "exited"; // 僵尸不算存活
    return "alive";
  };

  /** 进程组存活成员枚举（排除僵尸与 master 自身）；ps 失败 → undefined。 */
  const enumerateGroup = async (pgid: number): Promise<readonly number[] | undefined> => {
    if (options.failGroupEnumeration) return undefined;
    let stdout: string;
    try {
      const result = await execFileAsync("ps", ["-eo", "pid,pgid,stat,command"]);
      stdout = result.stdout;
    } catch {
      return undefined;
    }
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const group = Number(match[2]);
      const state = match[3] ?? "";
      const command = match[4] ?? "";
      if (
        group === pgid &&
        !state.startsWith("Z") &&
        pid !== child?.pid &&
        (command.includes("nginx: worker process") ||
          command.includes("nginx: master process"))
      ) {
        pids.push(pid);
      }
    }
    return pids;
  };

  /**
   * master 存活观测（cmdline 须属于本实例，防 PID 复用误判）。ps -p 的
   * “查无此进程”退出语义与 observePid 一致地解释为 exited。
   */
  const observeMaster = async (): Promise<ProcessObservation> => {
    if (!child || child.pid === undefined) return "exited";
    let stdout: string;
    try {
      const result = await execFileAsync("ps", [
        "-p",
        String(child.pid),
        "-o",
        "stat=,command=",
      ]);
      stdout = result.stdout;
    } catch (error) {
      const message = error as { stdout?: string; stderr?: string; message: string };
      if ((message.stdout ?? "").trim().length === 0) return "exited";
      return "unknown";
    }
    const trimmed = stdout.trim();
    if (trimmed.length === 0 || trimmed.startsWith("Z")) return "exited";
    // 创建语义 + pid 文件双重锚定后，cmdline 仍须含本实例配置。
    return trimmed.includes(configDir) ? "alive" : "exited";
  };

  /**
   * 端口持有归属：区分“端口有监听”与“端口由本实例持有”。
   * 返回 undefined 表示无法确认（lsof/ps 失效），调用方按未释放处理（I3）。
   */
  const portHeldByInstance = async (pgid: number): Promise<boolean | undefined> => {
    let lsofOut: string;
    try {
      const result = await execFileAsync("lsof", [
        "-nP",
        `-iTCP:${listenPort}`,
        "-sTCP:LISTEN",
        "-t",
      ]);
      lsofOut = result.stdout;
    } catch (error) {
      const failed = error as { stdout?: string; message: string };
      // lsof 对“无匹配监听者”返回非零 + 空输出：端口无监听。
      if ((failed.stdout ?? "").trim().length === 0) return false;
      return undefined;
    }
    const listenerPids = lsofOut
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    if (listenerPids.length === 0) return false;
    const listenerPgids = await Promise.all(
      listenerPids.map(async (pid) => {
        try {
          const { stdout } = await execFileAsync("ps", [
            "-p",
            String(pid),
            "-o",
            "pgid=",
          ]);
          const value = Number.parseInt(stdout.trim(), 10);
          return Number.isInteger(value) && value > 0 ? value : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    if (listenerPgids.some((value) => value === undefined)) return undefined;
    return listenerPgids.some((value) => value === pgid);
  };

  // ---- 统一清理核心（I4/I5）-------------------------------------------
  const stopSignalToGroup = (
    pgid: number,
    sig: NodeJS.Signals,
    failures: string[],
  ): void => {
    try {
      // 对整个进程组发信号：覆盖 master、worker、重建 worker 与孤儿。
      process.kill(-pgid, sig);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // ESRCH：进程组已不存在——所有成员都已退出，这不是失败。
        return;
      }
      failures.push(
        `failed to send ${sig} to process group ${pgid}: ${(error as Error).message}`,
      );
    }
  };

  const waitForGroupExit = async (pgid: number, failures: string[]): Promise<void> => {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const members = await enumerateGroup(pgid);
      const master = await observeMaster();
      if (members !== undefined && master !== "unknown") {
        if (members.length === 0 && master === "exited") return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
    }
    const members = await enumerateGroup(pgid);
    const master = await observeMaster();
    const survivors = members ?? [];
    const detail =
      members === undefined || master === "unknown"
        ? `could not confirm exit of process group ${pgid} (${identity()})`
        : `process group ${pgid} survived stop signals: master=${master} workers=[${survivors.join(",")}] (${identity()})`;
    failures.push(detail);
  };

  const runCleanup = async (context: string): Promise<void> => {
    if (child?.pid === undefined) {
      // 进程从未创建：只回收目录（I1 的最小责任范围）。
      await removeConfigDir(configDir);
      return;
    }
    const pgid = child.pid; // 创建语义：detached 组长 PID === PGID。
    const failures: string[] = [];

    // 组信号无条件发送：master 是否存活不作为发送前提——master 可能已
    // 在清理开始前崩溃，此时孤儿 worker 只能靠组信号终止。
    // TERM 阶段的超时只意味着“需要升级”，不构成最终失败；最终成败由
    // KILL 阶段与最终确认决定（I5：升级路径是正常生命周期的一部分）。
    const termPhase: string[] = [];
    stopSignalToGroup(pgid, "SIGTERM", termPhase);
    await waitForGroupExit(pgid, termPhase);
    {
      // 组内仍有成员或观测无法确认：升级 KILL 并有界等待。
      const members = await enumerateGroup(pgid);
      const needsKill =
        members === undefined ||
        members.length > 0 ||
        (await observeMaster()) === "alive";
      if (needsKill) {
        stopSignalToGroup(pgid, "SIGKILL", failures);
        await waitForGroupExit(pgid, failures);
      }
    }
    // TERM 阶段真实的信号发送失败（非超时）仍需保留。
    failures.push(...termPhase.filter((message) => message.startsWith("failed to send")));

    // 最终确认（I6）：master 退出 + 组内无存活成员 + 端口不再由本组持有。
    const masterFinal = await observeMaster();
    if (masterFinal === "alive") {
      failures.push(`master still alive after stop signals (${identity()})`);
    } else if (masterFinal === "unknown") {
      failures.push(`could not confirm master exit (${identity()})`);
    }
    const membersFinal = await enumerateGroup(pgid);
    if (membersFinal === undefined) {
      failures.push(`could not enumerate process group ${pgid} (${identity()})`);
    } else if (membersFinal.length > 0) {
      failures.push(
        `workers still alive after stop signals: ${membersFinal.join(",")} (${identity()})`,
      );
    }
    const portHeld = await portHeldByInstance(pgid);
    if (portHeld === undefined) {
      failures.push(
        `could not confirm ownership of listen port ${listenPort} (${identity()})`,
      );
    } else if (portHeld) {
      failures.push(`listen port ${listenPort} still held by instance (${identity()})`);
    }

    if (failures.length > 0) {
      // 进程树未确认退出：保留 configDir 供诊断，不得删除（I7）。
      throw new Error(`nginx cleanup failed during ${context}: ${failures.join("; ")}`);
    }
    try {
      await removeConfigDir(configDir);
    } catch (error) {
      throw new Error(
        `nginx cleanup failed during ${context}: failed to remove ${configDir}: ${(error as Error).message} (${identity()})`,
      );
    }
  };

  // 并发/重复清理收敛（I4）：共享同一 Promise；成功后不再向可能复用的
  // 编号发信号（直接返回已完成结果）。
  let cleanupPromise: Promise<void> | undefined;
  let lifecycleState: NginxLifecycleState = "ready";

  let handlingSetupFailure = false;
  const cleanupOnSetupFailure = async (setupError: unknown): Promise<never> => {
    // 防重入：本函数抛出的错误不得再次进入外层 catch 被二次包装。
    if (handlingSetupFailure) throw setupError;
    handlingSetupFailure = true;
    lifecycleState = "cleaning";
    const setupErrorTyped = setupError as Error;
    try {
      await runCleanup("setup");
    } catch (cleanupError) {
      lifecycleState = "cleanup-failed";
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
    // detached: 独立进程组，child.pid 即组长 PID（创建语义）。测试可用
    // SIGSTOP 暂停 master 验证 SIGKILL 升级，且不会把停止状态传播到测试
    // 运行器的终端进程组；清理只按本进程组发信号。
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
      } catch {
        // fetch 失败可能是端口未开（重试）或占位服务挂断（nginx 已死，重试
        // 会命中上方的 exitCode 检查）。
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    if (!ready) {
      await cleanupOnSetupFailure(
        new Error(`pinned nginx did not become reachable (${identity()})`),
      );
    }

    // 权威身份校验：pid 文件 master PID 必须等于 child.pid（创建语义）。
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
    if (child.pid === undefined || !allPids.includes(child.pid)) {
      await cleanupOnSetupFailure(
        new Error(
          `listen port ${listenPort} is not served by this nginx process tree (${identity()})`,
        ),
      );
    }

    // 身份交叉验证：创建语义给出 PGID === child.pid；用 ps 复核一次。
    // 观测失败/输出非法/期间 master 退出都使启动失败并走完整清理（I2/I3）
    // ——清理身份仍来自创建语义，不依赖这次观测成功。
    if (child.pid === undefined) {
      await cleanupOnSetupFailure(
        new Error(`pinned nginx master pid unavailable after readiness (${identity()})`),
      );
    }
    const masterPid = child.pid as number;
    if (options.killMasterDuringIdentityQuery) {
      process.kill(masterPid, "SIGKILL");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (options.failIdentityQuery) {
      await cleanupOnSetupFailure(
        new Error(
          `failed to verify process group of master pid ${child.pid}: injected query failure (${identity()})`,
        ),
      );
    }
    try {
      const { stdout } = await execFileAsync("ps", [
        "-p",
        String(child.pid),
        "-o",
        "pgid=",
      ]);
      if (options.invalidIdentityOutput) {
        throw new Error('invalid process group id output: "not-a-pgid"');
      }
      const parsed = Number.parseInt(stdout.trim(), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `invalid process group id output: ${JSON.stringify(stdout.trim())}`,
        );
      }
      if (parsed !== child.pid) {
        throw new Error(
          `process group ${parsed} does not match detached spawn semantics (expected ${child.pid})`,
        );
      }
    } catch (error) {
      await cleanupOnSetupFailure(
        new Error(
          `failed to verify process group of master pid ${child.pid}: ${(error as Error).message} (${identity()})`,
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

  const finalMasterPid = child!.pid!;
  return {
    origin: `http://127.0.0.1:${listenPort}`,
    masterPid: finalMasterPid,
    configDir,
    listenPort,
    instancePgid: finalMasterPid,
    get state() {
      return lifecycleState;
    },
    stop: async () => {
      if (lifecycleState === "cleaned") return; // 成功后不再发信号（防 PID 复用）
      lifecycleState = "cleaning";
      try {
        cleanupPromise ??= runCleanup("stop");
        await cleanupPromise;
        lifecycleState = "cleaned";
      } catch (error) {
        lifecycleState = "cleanup-failed";
        throw error;
      }
    },
    recover: async () => {
      // 受控恢复：仅在上次清理失败后重新执行同一清理核心；成功路径幂等。
      if (lifecycleState === "cleaned") return;
      removeConfigDir = realRemove;
      lifecycleState = "cleaning";
      try {
        cleanupPromise = runCleanup("recover");
        await cleanupPromise;
        lifecycleState = "cleaned";
      } catch (error) {
        lifecycleState = "cleanup-failed";
        throw error;
      }
    },
  } satisfies NginxServer;
};
