import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { createServer, type Server } from "node:http";

import { expect } from "vitest";
import { expect as pwExpect, type Page } from "@playwright/test";

const projectRoot = process.cwd();

export const viewports = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1280, height: 800 },
} as const;

export const expectNoRootHorizontalOverflow = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
};

export const expectNoConsoleErrors = (page: Page, errors: string[]): void => {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
};

export const expectVisibleText = async (page: Page, text: string): Promise<void> => {
  await pwExpect(page.getByText(text, { exact: false }).first()).toBeVisible();
};

const contentTypeFor = (path: string): string => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
};

export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; worker-src 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

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
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          ...securityHeaders,
        });
        response.end("not found");
        return;
      }
      const body = await readFile(join(distRoot, filePath.slice(1)));
      response.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control":
          filePath.startsWith("/media/sha256/") || filePath.startsWith("/_astro/")
            ? "public, max-age=31536000, immutable"
            : "no-cache, must-revalidate",
        ...securityHeaders,
      });
      response.end(body);
    } catch {
      response.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        ...securityHeaders,
      });
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
