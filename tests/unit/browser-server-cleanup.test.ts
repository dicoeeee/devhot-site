import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { serveDistribution } from "../support/browser-server";

it.each(["idle", "partial headers"])(
  "closes its own HTTP server with a real %s connection still open",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "devhot-http-cleanup-"));
    await writeFile(join(root, "index.html"), "healthy");
    const server = await serveDistribution(root);
    const other = await serveDistribution(root);
    const address = new URL(server.origin);
    const socket = connect(Number(address.port), address.hostname);
    socket.on("error", () => {}); // A reset is an expected way to close this probe.
    const disconnected = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    let closing: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await once(socket, "connect");
      expect(await (await fetch(server.origin)).text()).toBe("healthy");
      if (kind === "partial headers") {
        await new Promise<void>((resolve, reject) => {
          socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n", (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
      closing = server.close();
      const result = await Promise.race([
        Promise.all([closing, disconnected]).then(() => "closed"),
        new Promise<string>((resolve) => {
          deadline = setTimeout(() => resolve("still open"), 1000);
        }),
      ]);
      expect(result).toBe("closed");
      expect(await (await fetch(other.origin)).text()).toBe("healthy");
      const probe = connect(Number(address.port), address.hostname);
      try {
        const outcome = await new Promise<string>((resolve) => {
          probe.once("connect", () => resolve("connected"));
          probe.once("error", (error: NodeJS.ErrnoException) =>
            resolve(error.code ?? "unknown"),
          );
        });
        expect(outcome).toBe("ECONNREFUSED");
      } finally {
        probe.destroy();
      }
    } finally {
      clearTimeout(deadline);
      socket.destroy();
      await (closing ?? server.close());
      await other.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
