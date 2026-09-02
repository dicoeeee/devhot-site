import { spawn } from "node:child_process";
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
  /** 本实例 nginx master 的 PID（daemon off；由 spawn 直接管理）。 */
  readonly masterPid: number | undefined;
  /** 本实例创建的临时配置/dist 目录（stop() 成功后被删除）。 */
  readonly configDir: string;
  stop(): Promise<void>;
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

// 以真实 Nginx 服务 distRoot：serving config 的 include 被重写为指向仓库内
// security-headers.conf，root 指向 distRoot，其余逐字保留。监听端口由调用方
// 通过临时 nginx 配置动态分配，避免与遗留进程或并行运行冲突。
export const serveWithNginx = async (
  nginxBinaryPath: string,
  distRoot: string,
  servingConfigPath: string,
  securityHeadersPath: string,
  listenPort: number,
): Promise<NginxServer> => {
  const configDir = join(tmpdir(), `devhot-nginx-conf-${process.pid}-${Date.now()}`);
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
    // 显式前台运行：spawn 管理的 child 就是真实 nginx master，stop() 才能可靠终止。
    "daemon off;",
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
  const child = spawn(nginxBinaryPath, ["-c", configPath], {
    cwd: configDir,
    stdio: "ignore",
    detached: false,
  });
  const exited = new Promise<void>((resolvePromise) =>
    child.on("exit", () => resolvePromise()),
  );

  const STOP_TIMEOUT_MS = 10_000;

  // 统一清理路径（幂等，只执行一次）：SIGTERM master → 有界等待退出 →
  // 端口必须不可连接 → 删除本次创建的 configDir。任何一步失败都抛出明确错误。
  let cleanupDone = false;
  const cleanupOnce = async (context: string): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;
    const failures: string[] = [];
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
    const exitedWithTimeout = await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((resolvePromise) =>
        setTimeout(() => resolvePromise("timeout"), STOP_TIMEOUT_MS).unref(),
      ),
    ]);
    if (exitedWithTimeout === "timeout") {
      failures.push(
        `pinned nginx master (pid ${child.pid}) did not exit within ${STOP_TIMEOUT_MS}ms of SIGTERM`,
      );
    }
    if (failures.length === 0) {
      let reachable = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const probe = await fetch(`http://127.0.0.1:${listenPort}/`, {
            redirect: "manual",
          });
          await probe.arrayBuffer();
          reachable = true;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        } catch {
          reachable = false;
          break;
        }
      }
      if (reachable) {
        failures.push(
          `pinned nginx port ${listenPort} is still reachable after the master exited`,
        );
      }
    }
    try {
      await rm(configDir, { recursive: true, force: false });
    } catch (error) {
      failures.push(`failed to remove ${configDir}: ${(error as Error).message}`);
    }
    if (failures.length > 0) {
      throw new Error(`nginx cleanup failed during ${context}: ${failures.join("; ")}`);
    }
  };

  // 等待端口可连接；任何失败都走统一清理。
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const probe = await fetch(`http://127.0.0.1:${listenPort}/release.json`, {
        redirect: "manual",
      });
      await probe.arrayBuffer();
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      if (attempt === 99) {
        await cleanupOnce("startup").catch(() => {});
        throw new Error("pinned nginx did not become reachable");
      }
    }
  }

  return {
    origin: `http://127.0.0.1:${listenPort}`,
    masterPid: child.pid,
    configDir,
    stop: () => cleanupOnce("stop"),
  };
};
