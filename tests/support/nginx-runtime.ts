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

// 构建配方身份：缓存命中必须绑定“实际内容 + 构建配方”，不能绑定缓存
// 路径名。任何配方要素变化（版本、tarball 指纹、configure 参数、配方
// 版本、平台、架构）都会产生新的缓存目录身份，旧缓存不会被当作当前
// 固定运行时复用。
const RUNTIME_RECIPE_VERSION = 2;
const NGINX_CONFIGURE_ARGS = [
  // rewrite 模块必须启用：error_page/内部重定向按状态改写缓存策略
  // 依赖它；此前为最小化构建而排除。
  "--without-http_gzip_module",
] as const;
const recipeFingerprint = createHash("sha256")
  .update(
    JSON.stringify({
      recipeVersion: RUNTIME_RECIPE_VERSION,
      nginxVersion: NGINX_VERSION,
      tarballSha256: NGINX_TARBALL_SHA256,
      configureArgs: NGINX_CONFIGURE_ARGS,
      platform: process.platform,
      arch: process.arch,
    }),
  )
  .digest("hex");
const runtimeRoot = join(
  tmpdir(),
  `devhot-nginx-${NGINX_VERSION}-${recipeFingerprint.slice(0, 16)}`,
);
const nginxBinary = join(runtimeRoot, "sbin", "nginx");
const installMarkerPath = join(runtimeRoot, ".install-complete");

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

interface RuntimeInstallMarker {
  readonly schemaVersion: 2;
  readonly nginxVersion: string;
  readonly tarballSha256: string;
  readonly recipeFingerprint: string;
  readonly binarySha256: string;
}

const readMarker = async (): Promise<RuntimeInstallMarker | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(installMarkerPath, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 2 ||
      typeof (parsed as { nginxVersion?: unknown }).nginxVersion !== "string" ||
      typeof (parsed as { tarballSha256?: unknown }).tarballSha256 !== "string" ||
      typeof (parsed as { recipeFingerprint?: unknown }).recipeFingerprint !== "string" ||
      typeof (parsed as { binarySha256?: unknown }).binarySha256 !== "string"
    ) {
      return undefined;
    }
    return parsed as RuntimeInstallMarker;
  } catch {
    return undefined;
  }
};

/**
 * 原始执行：同时捕获 stdout 与 stderr（nginx -V 把版本信息写到 stderr，
 * promisify(execFile) 的成功路径拿不到 stderr）。
 */
const execCapture = (
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        if (typeof (error as { code?: unknown }).code === "number") {
          resolvePromise({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: (error as { code: number }).code,
          });
          return;
        }
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
    });
  });

/**
 * 解析 nginx -V 输出，验证版本、关键 configure 参数与编译期 prefix。
 * 伪二进制（如“exit 0”脚本）无法产出带版本前缀的输出，直接判为不匹配；
 * prefix 不匹配（如从 staging 复制来的产物，其编译期 temp/log 路径指向
 * 已删除目录）同样拒绝。
 */
const verifyNginxVersionOutput = (
  versionOutput: string,
): { ok: boolean; detail: string } => {
  if (!versionOutput.includes(`nginx version: nginx/${NGINX_VERSION}`)) {
    return {
      ok: false,
      detail: `unexpected version output: ${JSON.stringify(versionOutput.trim().slice(0, 80))}`,
    };
  }
  if (!versionOutput.includes(`--prefix=${runtimeRoot}`)) {
    return { ok: false, detail: `compiled prefix does not match ${runtimeRoot}` };
  }
  for (const arg of NGINX_CONFIGURE_ARGS) {
    if (!versionOutput.includes(arg)) {
      return { ok: false, detail: `configure argument missing from binary: ${arg}` };
    }
  }
  return { ok: true, detail: "" };
};

/**
 * 仅用于合并“正在进行”的并发准备：settled（无论成败）后即清空，后续
 * 每次独立调用都重新验证当前缓存（verifyCachedRuntime）。不做进程内
 * 永久信任——缓存目录在进程生命周期内可能被外部替换。
 */
let runtimePrepareInFlight: Promise<string> | undefined;

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

/**
 * 校验已存在的缓存是否与当前构建配方完全一致：marker schema、配方
 * 指纹、二进制实际 SHA-256、nginx -V 版本与 configure 参数。任一不符
 * 都不当作固定运行时（调用方会重建；不广泛删除其他缓存目录）。
 */
const verifyCachedRuntime = async (): Promise<boolean> => {
  if (!(await exists(nginxBinary))) return false;
  const marker = await readMarker();
  if (marker === undefined) return false;
  if (
    marker.nginxVersion !== NGINX_VERSION ||
    marker.tarballSha256 !== NGINX_TARBALL_SHA256 ||
    marker.recipeFingerprint !== recipeFingerprint
  ) {
    return false;
  }
  // 校验实际二进制内容指纹，而不是只执行一个退出码为 0 的文件。
  let binarySha: string;
  try {
    binarySha = sha256(await readFile(nginxBinary));
  } catch {
    return false;
  }
  if (binarySha !== marker.binarySha256) return false;
  // 解析 nginx -V：伪二进制无法伪造版本行与 configure 参数。
  try {
    const captured = await execCapture(nginxBinary, ["-V"]);
    const combined = `${captured.stdout}\n${captured.stderr}`;
    return verifyNginxVersionOutput(combined).ok;
  } catch {
    return false;
  }
};

/** 简单锁文件互斥：内容为持锁 PID；持锁进程不存在时视为陈旧可抢占。 */
interface RuntimeLock {
  readonly path: string;
  readonly token: string;
}

/**
 * 进程启动身份：PID + 该进程的启动时间（etime/lstart 派生的稳定值）。
 * PID 复用会产生同 PID 的不同进程，但启动时间不同——以此区分“锁的
 * 原持有进程”与“碰巧复用同号 PID 的无关进程”。这是判定陈旧锁的
 * 唯一依据；不使用“到时间就抢”的年龄阈值（合法慢构建可能超过任何
 * 期限，破坏活跃锁违反互斥契约）。
 */
const processStartIdentity = async (pid: number): Promise<string | undefined> => {
  try {
    const { stdout } = await execCapture("ps", ["-p", String(pid), "-o", "lstart="]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * 跨进程互斥锁：以 O_EXCL（"wx"）原子创建锁文件，同一时刻只有一个
 * 获取者成功。锁内容为 JSON（token + pid + startIdentity）：
 * - 释放只删除 token 完全匹配的自有锁；
 * - 陈旧判定 = 锁记录的持有进程不存在，或存在但启动身份与锁记录不符
 *   （说明原持有者已死、当前同号 PID 是复用后的无关进程）；
 * - 抢占走“先原子换名（带走旧锁内容）、再检查换名结果中的 token 是否
 *   就是此前读取的同一 token”的 CAS 协议：读取与换名之间锁若被释放
 *   并被新持有者重建，换名会失败或换到的不是同一 token——两种情况都
 *   放弃并让调用方重试，绝不移动他人的新锁；
 * - 活跃持有者（进程存活且启动身份匹配）永不因年龄被抢占；调用方
 *   只能等待或最终报告锁超时。
 */
export const acquireLock = async (lockPath: string): Promise<RuntimeLock | undefined> => {
  await mkdir(dirname(lockPath), { recursive: true });
  const { open } = await import("node:fs/promises");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    // 原子创建：EEXIST 即他人持有。
    const handle = await open(lockPath, "wx");
    try {
      const start = await processStartIdentity(process.pid);
      await handle.writeFile(
        `${JSON.stringify({ token, pid: process.pid, startIdentity: start ?? null })}\n`,
        "utf8",
      );
    } finally {
      await handle.close();
    }
    return { path: lockPath, token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  // 锁已存在：仅当“持有进程已死（含 PID 复用）”时才允许回收。
  let record: { token: string; pid: number; startIdentity: string | null } | undefined;
  try {
    const content = (await readFile(lockPath, "utf8")).trim();
    record = JSON.parse(content) as {
      token: string;
      pid: number;
      startIdentity: string | null;
    };
    if (
      typeof record?.token !== "string" ||
      !Number.isInteger(record?.pid) ||
      (record?.startIdentity !== null && typeof record?.startIdentity !== "string")
    ) {
      record = undefined; // 锁内容损坏：按陈旧处理（可回收）。
    }
  } catch {
    return undefined; // 读取失败/恰好被释放：让调用方重试。
  }
  if (record === undefined) {
    // 损坏锁回收：CAS——换名成功且内容仍是损坏的同一份才继续。
    // （换名后再读回校验；损坏内容没有 token 可比对，故以“换名成功
    // 且文件内容与读取时一致”为准。）
    return reclaimByRename(lockPath, undefined);
  }
  const holderAlive = await isHolderAlive(record);
  if (holderAlive) return undefined; // 活跃持有者：等待，绝不抢占。
  return reclaimByRename(lockPath, record.token);
};

/** 持有者是否仍存活：进程存在且启动身份与锁记录一致（防 PID 复用）。 */
const isHolderAlive = async (record: {
  pid: number;
  startIdentity: string | null;
}): Promise<boolean> => {
  const currentStart = await processStartIdentity(record.pid);
  if (currentStart === undefined) return false; // 进程不存在。
  if (record.startIdentity === null) return true; // 锁未记录身份：仅按进程存在判定。
  return currentStart === record.startIdentity;
};

/**
 * 陈旧锁回收（独立原子协议）：先把锁 rename 到私有路径（原子带走），
 * 再读回并确认 token 与此前读取的同一 token——只有一致才视为回收
 * 成功；不一致（读取与换名之间已被新持有者替换）或 rename 失败都
 * 放弃，把私有路径残件清理后让调用方重试。
 */
const reclaimByRename = async (
  lockPath: string,
  expectedToken: string | undefined,
): Promise<RuntimeLock | undefined> => {
  const takeoverPath = `${lockPath}.stale-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const { rename } = await import("node:fs/promises");
  try {
    await rename(lockPath, takeoverPath);
  } catch {
    return undefined; // 并发变化：让调用方重试。
  }
  // 换名成功后校验：换到的必须仍是此前读取的那份锁。
  let movedContent = "";
  try {
    movedContent = (await readFile(takeoverPath, "utf8")).trim();
  } catch {
    // 无法读回：按无法确认处理，不回收。
    await rm(takeoverPath, { force: true }).catch(() => {});
    return undefined;
  }
  if (expectedToken !== undefined) {
    let movedToken: unknown;
    try {
      movedToken = (JSON.parse(movedContent) as { token?: unknown }).token;
    } catch {
      movedToken = undefined;
    }
    if (movedToken !== expectedToken) {
      // 读取与换名之间锁已被替换：这是他人的新锁，必须放回原位。
      try {
        await rename(takeoverPath, lockPath);
      } catch {
        // 放回失败（原位已被新锁占用）：把私有残件留在 stale 路径供诊断，
        // 不删除他人锁。
      }
      return undefined;
    }
  }
  await rm(takeoverPath, { force: true }).catch(() => {});
  // 回收成功：重新以 O_EXCL 创建自有锁（递归一次，不无限循环）。
  const { open } = await import("node:fs/promises");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const handle = await open(lockPath, "wx");
    try {
      const start = await processStartIdentity(process.pid);
      await handle.writeFile(
        `${JSON.stringify({ token, pid: process.pid, startIdentity: start ?? null })}\n`,
        "utf8",
      );
    } finally {
      await handle.close();
    }
    return { path: lockPath, token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return undefined; // 并发者先创建了：让调用方重试。
  }
};

/** 释放锁：token 完全匹配才删除（不会误删他人的新锁）。 */
const releaseLock = async (lock: RuntimeLock): Promise<void> => {
  try {
    const content = (await readFile(lock.path, "utf8")).trim();
    let currentToken: unknown;
    try {
      currentToken = (JSON.parse(content) as { token?: unknown }).token;
    } catch {
      currentToken = undefined;
    }
    if (currentToken === lock.token) {
      await rm(lock.path, { force: true });
    }
  } catch {
    // 锁已不存在。
  }
};

// 安装固定运行时：每次调用都先验证当前缓存内容；未命中时进行准备，
// 期间并发的调用合并到同一次 in-flight 准备（settled 后引用清空）。
export const ensureNginxRuntime = async (): Promise<string> => {
  if (await verifyCachedRuntime()) {
    return nginxBinary;
  }
  if (runtimePrepareInFlight !== undefined) {
    return runtimePrepareInFlight;
  }
  const prepared = prepareNginxRuntime().finally(() => {
    // settled 后立即清空 in-flight 引用：后续调用重新验证缓存。
    if (runtimePrepareInFlight === prepared) runtimePrepareInFlight = undefined;
  });
  runtimePrepareInFlight = prepared;
  return prepared;
};

const prepareNginxRuntime = async (): Promise<string> => {
  if (await verifyCachedRuntime()) {
    return nginxBinary;
  }
  const lockPath = `${runtimeRoot}.lock`;
  let lock: RuntimeLock | undefined;
  // 有界抢锁循环：他人持锁时等待其完成；锁释放/陈旧后重试原子获取。
  for (let attempt = 0; attempt < 600 && lock === undefined; attempt += 1) {
    lock = await acquireLock(lockPath);
    if (lock !== undefined) break;
    // 等待期间持续复查：前一个构建者可能已完成（此时直接复用缓存）。
    if (await verifyCachedRuntime()) return nginxBinary;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (lock === undefined) {
    throw new Error("pinned nginx runtime cache is locked by another process");
  }
  // 获得锁后再次验证：前一个构建者可能在等待期间完成，避免重复重建。
  if (await verifyCachedRuntime()) {
    await releaseLock(lock);
    return nginxBinary;
  }
  try {
    // 当前缓存目录与配方不符（可能为伪内容、半安装或旧配方）：只处理
    // 这一精确目标，不删除其他 devhot-nginx-* 目录。
    await rm(runtimeRoot, { recursive: true, force: true });
    await mkdir(join(runtimeRoot, "src"), { recursive: true });

    const sourceRoot = join(runtimeRoot, "src", `nginx-${NGINX_VERSION}`);
    try {
      const tarball = Buffer.from(
        await (await fetch(NGINX_URL, { redirect: "follow" })).arrayBuffer(),
      );
      if (sha256(tarball) !== NGINX_TARBALL_SHA256) {
        throw new Error("pinned nginx tarball sha256 mismatch");
      }
      const tarballPath = join(runtimeRoot, `nginx-${NGINX_VERSION}.tar.gz`);
      await writeFile(tarballPath, tarball);
      await exec(
        "tar",
        ["-xzf", `nginx-${NGINX_VERSION}.tar.gz`, "-C", "src"],
        runtimeRoot,
      );
      // 直接以最终位置为 --prefix 安装（nginx 把 prefix 编译进二进制，
      // 供 temp/log 路径使用；跨目录复制会得到指向已删除 staging 的
      // 编译期路径）。半安装由 marker 门控：marker 只在完整构建与全部
      // 验证后原子写入，无 marker 的目录不会被 verifyCachedRuntime 接受。
      await exec(
        join(sourceRoot, "configure"),
        [
          `--prefix=${runtimeRoot}`,
          `--sbin-path=${nginxBinary}`,
          ...NGINX_CONFIGURE_ARGS,
        ],
        sourceRoot,
      );
      await exec("make", ["-j", "4"], sourceRoot);
      await exec("make", ["install"], sourceRoot);
    } finally {
      // 源码目录与 tarball 仅构建期需要；安装完成后移除（缓存保持精简）。
      await rm(join(runtimeRoot, "src"), { recursive: true, force: true }).catch(
        () => {},
      );
      await rm(join(runtimeRoot, `nginx-${NGINX_VERSION}.tar.gz`), {
        force: true,
      }).catch(() => {});
    }

    if (!(await exists(nginxBinary))) {
      throw new Error("pinned nginx binary is missing after install");
    }
    const binarySha = sha256(await readFile(nginxBinary));
    // 内容验证：版本输出与 configure 参数（同时捕获 stdout 与 stderr）。
    const captured = await execCapture(nginxBinary, ["-V"]);
    const verdict = verifyNginxVersionOutput(`${captured.stdout}\n${captured.stderr}`);
    if (!verdict.ok) {
      throw new Error(`built nginx binary failed verification: ${verdict.detail}`);
    }
    // marker 只在完整构建与验证成功后原子写入（临时文件 + rename）。
    const marker: RuntimeInstallMarker = {
      schemaVersion: 2,
      nginxVersion: NGINX_VERSION,
      tarballSha256: NGINX_TARBALL_SHA256,
      recipeFingerprint: recipeFingerprint,
      binarySha256: binarySha,
    };
    const markerTemp = `${installMarkerPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(markerTemp, `${JSON.stringify(marker, null, 2)}\n`);
    const { rename } = await import("node:fs/promises");
    await rename(markerTemp, installMarkerPath);
    return nginxBinary;
  } finally {
    await releaseLock(lock);
  }
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

/**
 * 资源清理能力：从资源创建时刻起始终可达（I1/R1）。即使启动函数抛错，
 * 调用方也能通过 NginxSetupError.resource 拿到该能力，无需解析错误
 * 字符串、扫描全机进程或扫描临时目录。
 *
 * 迟到恢复的复用安全：绝不无条件向裸编号发信号。信号策略按当前观测
 * 决定——master 仍被证明存活（cmdline 绑定 configDir）时对整个进程组
 * 发信号；master 已退出时只对“仍属于该进程组”的成员逐一确认后发信号。
 */
export interface NginxResourceHandle {
  /** 实例身份（创建时确定，不可变）。 */
  readonly configDir: string;
  readonly listenPort: number;
  /** 创建语义身份：detached 组长 PID === PGID。 */
  readonly instancePgid: number;
  /** master PID（创建时记录；迟到恢复时仅作诊断参考，不作为发信号依据）。 */
  readonly masterPid: number | undefined;
  /** 受控恢复：重新执行完整清理核心（外部条件修复后调用）。 */
  recover(): Promise<void>;
}

/** 启动失败错误：携带结构化资源与恢复能力，双错误保留。 */
export class NginxSetupError extends Error {
  readonly resource: NginxResourceHandle;
  readonly setupError: Error;
  readonly cleanupError: Error | undefined;

  constructor(
    message: string,
    resource: NginxResourceHandle,
    setupError: Error,
    cleanupError: Error | undefined,
  ) {
    super(message);
    this.name = "NginxSetupError";
    this.resource = resource;
    this.setupError = setupError;
    this.cleanupError = cleanupError;
  }
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
  /**
   * 测试注入：模拟 master 的 ps -p 观测以指定退出码/stderr 失败。
   * 按 ps -p 契约分类：仅“退出码 1 + 空 stdout + 空 stderr”是 target
   * -absent；携带 stderr 的失败一律 UNKNOWN。
   */
  readonly masterObservationExitCode?: number;
  readonly masterObservationStderr?: string;
  /**
   * 测试注入：模拟 lsof 以指定退出码/stderr 失败。仅“退出码 1 + 空
   * stderr”是无匹配监听者；携带 stderr（如 "observer denied"）一律
   * UNKNOWN，不得放行清理。
   */
  readonly lsofExitCode?: number;
  readonly lsofStderr?: string;
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

  // ---- 观测原语：ps/lsof 只读。返回结构化命令结果，只有可明确识别的
  // ---- “目标不存在”语义才允许折叠为 EXITED；其余失败一律 UNKNOWN（I3）。
  /** 命令执行的结构化结果：退出码与输出分离，不用空 stdout 猜测语义。 */
  type ObserverResult = Readonly<
    | { kind: "ok"; stdout: string; stderr: string }
    | { kind: "failed"; code: number | string; stdout: string; stderr: string }
  >;
  const runObserver = (
    command: string,
    args: readonly string[],
  ): Promise<ObserverResult> =>
    execCapture(command, args).then(
      (result): ObserverResult =>
        result.code === 0
          ? { kind: "ok", stdout: result.stdout, stderr: result.stderr }
          : {
              kind: "failed",
              code: result.code ?? "unknown",
              stdout: result.stdout,
              stderr: result.stderr,
            },
      (error: unknown): ObserverResult => {
        const failed = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        return {
          kind: "failed",
          code: failed.code ?? "unknown",
          stdout: failed.stdout ?? "",
          stderr: failed.stderr ?? "",
        };
      },
    );

  /**
  /**
   * 按命令分别定义"成功 / 目标不存在 / 观测失败"语义，并验证输出本身：
   * "命令成功"（退出码 0）不等于"观测有效"——输出必须满足该命令的
   * 语法与完整性契约，否则一律 UNKNOWN：
   * - ps -p PID：退出码 0 时必须得到可解析的目标进程状态（非空、且为
   *   合法 ps 状态串）；空输出或非法状态为 UNKNOWN。退出码 1 且
   *   stdout 空且 stderr 空才是"查无此进程"。
   * - ps -eo：退出码 0 时输出必须能解析为完整的进程表（剥离一次表头
   *   后至少一条记录，且每条记录都可按"pid pgid stat command"解析）；
   *   空输出、仅表头或存在无法解析的数据行为 UNKNOWN（不得静默跳过
   *   非法行得到空集）。任何非零退出（含 1）都是 UNKNOWN。
   * - lsof -t：退出码 0 时必须至少解析出一个合法 PID；空输出或非法
   *   PID 为 UNKNOWN。退出码 1 且 stderr 空才是"无匹配监听者"。
   */
  type ObserverOutcome =
    | { readonly kind: "ok"; readonly stdout: string }
    | { readonly kind: "target-absent" }
    | { readonly kind: "unknown"; readonly reason: string };

  /**
   * ps -p 的按输出格式验证：stat（状态串）、command（命令行）、pgid
   *（正整数）。同一命令不同 -o 字段的输出形状不同，验证必须与调用点
   * 的期望格式一致——否则会把合法输出（如 pgid 的数字）误判为非法。
   */
  const validatePsPOutput = (
    format: "stat" | "command" | "pgid",
    stdout: string,
    detail: string,
  ): ObserverOutcome => {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return { kind: "unknown", reason: `ps -p succeeded with empty output (${detail})` };
    }
    if (format === "stat" && !isValidPsState(trimmed)) {
      return { kind: "unknown", reason: `ps -p produced unparsable state (${detail})` };
    }
    if (format === "pgid" && !/^\d+$/.test(trimmed)) {
      return { kind: "unknown", reason: `ps -p produced unparsable pgid (${detail})` };
    }
    // command：任意非空文本（cmdline 内容本身不设语法约束）。
    return { kind: "ok", stdout };
  };

  /** ps 状态串合法性：字母 + 可选跟随标记（如 Ss、Ts、Z+、RWp 等）。 */
  const isValidPsState = (state: string): boolean => /^[A-Za-z][A-Za-z+]*$/.test(state);

  const classifyObserver = (
    command: "ps -p stat" | "ps -p command" | "ps -p pgid" | "ps -eo" | "lsof",
    result: Awaited<ReturnType<typeof runObserver>>,
  ): ObserverOutcome => {
    if (process.env.DBG_OBSERVER === "1") {
      process.stderr.write(
        `DBG_CLASSIFY ${command} kind=${result.kind} code=${result.kind === "failed" ? String(result.code) : "0"} stdoutLen=${result.stdout.length} stdoutHead=${JSON.stringify(result.stdout.slice(0, 30))}\n`,
      );
    }
    const { code, stdout, stderr } =
      result.kind === "ok"
        ? { code: 0 as const, stdout: result.stdout, stderr: result.stderr }
        : { code: result.code, stdout: result.stdout, stderr: result.stderr };
    const stderrQuiet = stderr.trim().length === 0;
    const detail = `code=${String(code)} stdout=${JSON.stringify(stdout.trim().slice(0, 40))} stderr=${JSON.stringify(stderr.trim().slice(0, 40))}`;
    if (code === 0) {
      // 命令成功 ≠ 观测有效：逐命令验证输出语法与完整性。
      if (
        command === "ps -p stat" ||
        command === "ps -p command" ||
        command === "ps -p pgid"
      ) {
        const format =
          command === "ps -p stat"
            ? "stat"
            : command === "ps -p pgid"
              ? "pgid"
              : "command";
        return validatePsPOutput(format, stdout, detail);
      }
      if (command === "ps -eo") {
        const allLines = stdout.split("\n").filter((line) => line.trim().length > 0);
        if (allLines.length === 0) {
          return {
            kind: "unknown",
            reason: `ps -eo succeeded with empty output (${detail})`,
          };
        }
        // BSD ps -eo 有表头行（"  PID  PGID STAT COMMAND"）；剥离一次表头
        // 后，每条数据行都必须可解析——静默跳过非法行会伪造"空进程组"。
        let records = allLines;
        if (!/^\s*\d+\s+\d+\s+\S+\s+.*$/.test(records[0] ?? "")) {
          records = records.slice(1);
        }
        if (records.length === 0) {
          return { kind: "unknown", reason: `ps -eo produced only a header (${detail})` };
        }
        const parsable = records.every((line) =>
          /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.test(line),
        );
        if (!parsable) {
          return {
            kind: "unknown",
            reason: `ps -eo produced unparsable records (${detail})`,
          };
        }
        return { kind: "ok", stdout };
      }
      // lsof -t：退出码 0 必须至少给出一个合法 PID。
      const pids = stdout
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      if (pids.length === 0) {
        return {
          kind: "unknown",
          reason: `lsof succeeded with no valid pid (${detail})`,
        };
      }
      return { kind: "ok", stdout };
    }
    if (command === "ps -eo") {
      // 全量枚举没有"目标不存在"退出语义：任何非零退出都是观测失败。
      return { kind: "unknown", reason: `ps -eo failed (${detail})` };
    }
    if (
      command === "ps -p stat" ||
      command === "ps -p command" ||
      command === "ps -p pgid"
    ) {
      if (code === 1 && stdout.trim().length === 0 && stderrQuiet) {
        return { kind: "target-absent" };
      }
      return { kind: "unknown", reason: `${command} failed (${detail})` };
    }
    // lsof -t：退出码 1 + 空 stderr = 无匹配监听者。
    if (code === 1 && stderrQuiet) return { kind: "target-absent" };
    return { kind: "unknown", reason: `lsof failed (${detail})` };
  };

  /**
   * 单个 PID 的存活观测（统一入口；所有 PID 观测——含 master——都经过
   * 这里，不存在平行语义）。
   */
  const observePid = async (pid: number): Promise<ProcessObservation> => {
    if (options.masterObservationExitCode !== undefined && pid === child?.pid) {
      // 注入的观测结果：按 ps -p 契约分类（含输出验证）。
      const injected = classifyObserver("ps -p stat", {
        kind: "failed",
        code: options.masterObservationExitCode,
        stdout: "",
        stderr: options.masterObservationStderr ?? "",
      });
      if (injected.kind === "target-absent") return "exited";
      if (injected.kind === "unknown") return "unknown";
    }
    const outcome = classifyObserver(
      "ps -p stat",
      await runObserver("ps", ["-p", String(pid), "-o", "stat="]),
    );
    if (outcome.kind === "unknown") return "unknown";
    if (outcome.kind === "target-absent") return "exited";
    const state = outcome.stdout.trim();
    // classifyObserver 已保证非空且合法（ok 路径经过输出验证）。
    if (state.startsWith("Z")) return "exited"; // 僵尸不算存活
    return "alive";
  };

  /** 进程组存活成员枚举（排除僵尸与 master 自身）；观测无效 → undefined。 */
  const enumerateGroup = async (pgid: number): Promise<readonly number[] | undefined> => {
    if (options.failGroupEnumeration) return undefined;
    const outcome = classifyObserver(
      "ps -eo",
      await runObserver("ps", ["-eo", "pid,pgid,stat,command"]),
    );
    if (outcome.kind !== "ok") return undefined;
    const pids: number[] = [];
    for (const line of outcome.stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue; // 空行/表头：classifyObserver 已验证全部数据行可解析。
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
   * master 存活观测（cmdline 须属于本实例，防 PID 复用误判）。
   * 基础存活语义统一经过 observePid（单一 PID 观测入口），其上叠加
   * cmdline 归属校验——不存在平行的 PID 语义。
   */
  const observeMaster = async (): Promise<ProcessObservation> => {
    if (!child || child.pid === undefined) return "exited";
    const liveness = await observePid(child.pid);
    if (liveness !== "alive") return liveness;
    // PID 存活后，cmdline 仍须属于本实例（创建语义 + pid 文件双重锚定），
    // 防止 PID 复用后被误认为本实例 master。
    const outcome = classifyObserver(
      "ps -p command",
      await runObserver("ps", ["-p", String(child.pid), "-o", "command="]),
    );
    if (outcome.kind === "unknown") return "unknown";
    if (outcome.kind === "target-absent") return "exited";
    const cmdline = outcome.stdout.trim();
    if (cmdline.length === 0) return "unknown"; // 空输出不可作为归属证据
    return cmdline.includes(configDir) ? "alive" : "exited";
  };

  /**
   * 端口持有归属：区分“端口有监听”与“端口由本实例持有”。
   * lsof 是可选观测：当实例进程组已被可靠证明不存在时，端口不可能再
   * 由该实例持有（返回 false）；当进程组状态为 UNKNOWN 时，lsof 缺失
   * 不得放行（返回 undefined，调用方按未释放处理）。
   */
  const portHeldByInstance = async (
    pgid: number,
    groupState: {
      readonly master: ProcessObservation;
      readonly members: readonly number[] | undefined;
    },
  ): Promise<boolean | undefined> => {
    // 证明链第一环：进程组已可靠证明不存在 → 端口不可能由本实例持有。
    const groupReliablyGone =
      groupState.master === "exited" &&
      groupState.members !== undefined &&
      groupState.members.length === 0;
    if (groupReliablyGone) return false;

    // 进程组状态未知或有存活成员：必须用 lsof 确认监听者归属。
    let lsofOutcome: ObserverOutcome;
    if (options.lsofExitCode !== undefined) {
      lsofOutcome = classifyObserver("lsof", {
        kind: "failed",
        code: options.lsofExitCode,
        stdout: "",
        stderr: options.lsofStderr ?? "",
      });
    } else {
      lsofOutcome = classifyObserver(
        "lsof",
        await runObserver("lsof", ["-nP", `-iTCP:${listenPort}`, "-sTCP:LISTEN", "-t"]),
      );
    }
    if (lsofOutcome.kind === "unknown") return undefined;
    let listenerPids: readonly number[] = [];
    if (lsofOutcome.kind === "ok") {
      // classifyObserver 已保证退出码 0 时至少含一个合法 PID；这里逐一
      // 解析且不接受任何非法行（非法行 = 观测无效，不是"无监听者"）。
      const nonEmpty = lsofOutcome.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const parsed: number[] = [];
      for (const line of nonEmpty) {
        const pid = Number.parseInt(line.trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) return undefined; // 非法 PID：UNKNOWN
        parsed.push(pid);
      }
      if (parsed.length === 0) return undefined; // 空输出在 ok 路径下不可信
      listenerPids = parsed;
    } // target-absent：无监听者 → listenerPids 保持空。
    const listenerPgids: (number | undefined)[] = [];
    for (const pid of listenerPids) {
      const psOutcome = classifyObserver(
        "ps -p pgid",
        await runObserver("ps", ["-p", String(pid), "-o", "pgid="]),
      );
      if (psOutcome.kind === "unknown") return undefined;
      if (psOutcome.kind === "target-absent") return undefined; // 监听者瞬间消失：无法确认
      const raw = psOutcome.stdout.trim();
      if (!/^\d+$/.test(raw)) return undefined; // 非法 pgid 输出：UNKNOWN
      const value = Number.parseInt(raw, 10);
      listenerPgids.push(value > 0 ? value : undefined);
    }
    if (listenerPgids.some((value) => value === undefined)) return undefined;
    return listenerPgids.some((value) => value === pgid);
  };

  // ---- 统一清理核心（I4/I5）-------------------------------------------
  /**
   * 复用安全的组信号发送。直接 kill(-pgid) 在迟到恢复（recover()）场景
   * 下有风险：PGID 是可复用编号，组销毁后同号组可能属于无关进程。发送
   * 前先证明“该组仍有本实例的已知成员”：master 仍被观测为 alive（其
   * cmdline 绑定 configDir，无法与无关进程混淆），或组枚举到 nginx
   * master/worker 成员。两者都无法确认时不发信号（进入 UNKNOWN 失败
   * 路径），绝不向可能复用的编号盲目发送。
   */
  const safeGroupSignal = async (
    pgid: number,
    sig: NodeJS.Signals,
    failures: string[],
  ): Promise<void> => {
    const master = await observeMaster();
    const members = await enumerateGroup(pgid);
    if (master === "exited" && members !== undefined && members.length === 0) {
      // 组已被可靠证明不存在：无需发信号。
      return;
    }
    if (master === "unknown" || members === undefined) {
      failures.push(
        `could not confirm ownership of process group ${pgid} before sending ${sig}; refusing to signal a possibly reused id (${identity()})`,
      );
      return;
    }
    try {
      // master alive（cmdline 绑定本实例）或组内仍有 nginx 成员：
      // 组仍属于本实例，可安全地对整组发信号（覆盖 worker 与孤儿）。
      process.kill(-pgid, sig);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // ESRCH：发送瞬间组已销毁——所有成员都已退出，这不是失败。
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
    await safeGroupSignal(pgid, "SIGTERM", termPhase);
    await waitForGroupExit(pgid, termPhase);
    {
      // 组内仍有成员或观测无法确认：升级 KILL 并有界等待。
      const members = await enumerateGroup(pgid);
      const needsKill =
        members === undefined ||
        members.length > 0 ||
        (await observeMaster()) === "alive";
      if (needsKill) {
        await safeGroupSignal(pgid, "SIGKILL", failures);
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
    // 端口证明链：进程组状态本身是证据；组 UNKNOWN 时 lsof 缺失不得放行。
    const portHeld = await portHeldByInstance(pgid, {
      master: masterFinal,
      members: membersFinal,
    });
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
    // 资源清理能力从创建时刻起始终可达：即使清理失败，调用方也能通过
    // 错误对象拿到 recover() 完成精确恢复（不解析字符串、不扫描目录）。
    const resource: NginxResourceHandle = {
      configDir,
      listenPort,
      instancePgid: child?.pid ?? -1,
      masterPid: child?.pid,
      recover: async () => {
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
    };
    try {
      await runCleanup("setup");
    } catch (cleanupError) {
      lifecycleState = "cleanup-failed";
      throw new NginxSetupError(
        "nginx setup failed and process cleanup failed",
        resource,
        setupErrorTyped,
        cleanupError as Error,
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
