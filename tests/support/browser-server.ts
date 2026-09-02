import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";

const projectRoot = process.cwd();

const contentTypeFor = (path: string): string => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
};

export interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

export const serveDistribution = async (distRoot: string): Promise<StaticServer> => {
  const server: Server = createServer(async (request, response) => {
    try {
      const rawPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      const normalized = rawPath.replace(/\/+$/, "") || "/";
      let filePath = normalized === "/" ? "/index.html" : normalized;
      let fileStat = await stat(join(distRoot, filePath.slice(1))).catch(() => null);
      if (!fileStat?.isFile() && !filePath.endsWith(".html")) {
        filePath = `${filePath}/index.html`;
        fileStat = await stat(join(distRoot, filePath.slice(1))).catch(() => null);
      }
      if (!fileStat?.isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      const body = await readFile(join(distRoot, filePath.slice(1)));
      response.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control": filePath.startsWith("/media/sha256/")
          ? "public, max-age=31536000, immutable"
          : "no-cache, must-revalidate",
      });
      response.end(body);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("server error");
    }
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to bind the static verification server");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
};

export interface BrowserBuild {
  readonly distRoot: string;
  cleanup(): Promise<void>;
}

const execFileAsync = (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${code}`));
    });
  });

export const buildReaderFixture = async (): Promise<BrowserBuild> => {
  const { writePublicationFixture } = await import("./publication-fixture");
  const { prepareStaticBuild } = await import("./static-build");
  const { copyDeclaredAssets } = await import("../../tools/copy-assets");
  const fixture = await writePublicationFixture({
    evidenceReadingContract: true,
    tagDetailContract: true,
  });
  const buildRoot = await prepareStaticBuild(fixture.root);
  await execFileAsync(
    process.execPath,
    [join(projectRoot, "node_modules", "astro", "bin", "astro.mjs"), "build"],
    buildRoot,
  );
  await copyDeclaredAssets({
    inputRoot: fixture.root,
    distRoot: join(buildRoot, "dist"),
  });
  const distRoot = join(buildRoot, "dist");
  return {
    distRoot,
    cleanup: async () => {
      await rm(buildRoot, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    },
  };
};

export const buildReaderOutput = async (): Promise<BrowserBuild> => {
  const { copyDeclaredAssets } = await import("../../tools/copy-assets");
  await copyDeclaredAssets({
    inputRoot: join(projectRoot, "site-input"),
    distRoot: join(projectRoot, "dist"),
  });
  return {
    distRoot: join(projectRoot, "dist"),
    cleanup: async () => {},
  };
};
