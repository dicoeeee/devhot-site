import { deepStrictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  NGINX_TARBALL_SHA256,
  prepareNginxSource,
  readNginxSource,
} from "../../tools/nginx-source";

let root: string;
let valid: Buffer;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "devhot-nginx-source-"));
  valid = await readNginxSource();
}, 240_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("reads pinned prepared bytes without a network request and rejects changed or missing input", async () => {
  const input = join(root, "source.tar.gz");
  await writeFile(input, valid);
  const denied = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("network forbidden"));
  try {
    expect(
      createHash("sha256")
        .update(await readNginxSource(input))
        .digest("hex"),
    ).toBe(NGINX_TARBALL_SHA256);
    await writeFile(input, "corrupt");
    await expect(readNginxSource(input)).rejects.toThrow("tarball sha256 mismatch");
    await expect(readNginxSource(join(root, "missing"))).rejects.toThrow();
    const alias = join(root, "alias");
    await symlink(input, alias);
    await expect(readNginxSource(alias)).rejects.toThrow();
    expect(denied).not.toHaveBeenCalled();
  } finally {
    denied.mockRestore();
  }
});

it("creates only a verified immutable input and never overwrites an existing destination", async () => {
  const output = join(root, "prepared.tar.gz");
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(new Uint8Array(valid)));
  try {
    await prepareNginxSource(output);
    deepStrictEqual(await readFile(output), valid);
    expect((await stat(output)).mode & 0o777).toBe(0o444);
    await expect(prepareNginxSource(output)).rejects.toMatchObject({ code: "EEXIST" });
    deepStrictEqual(await readFile(output), valid);
    fetcher.mockResolvedValue(new Response("corrupt"));
    const rejected = join(root, "rejected.tar.gz");
    await expect(prepareNginxSource(rejected)).rejects.toThrow("tarball sha256 mismatch");
    await expect(stat(rejected)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    fetcher.mockRestore();
  }
});

it("never publishes failed, oversized or unavailable downloads", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    for (const [name, response] of [
      ["http", new Response("unavailable", { status: 503 })],
      ["oversized", new Response(new Uint8Array(8 * 1024 * 1024 + 1))],
    ] as const) {
      fetcher.mockResolvedValue(response);
      const destination = join(root, name);
      await expect(prepareNginxSource(destination)).rejects.toThrow(
        "deployment_nginx_source_unavailable",
      );
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const offline = new Error("controlled connection timeout");
    fetcher.mockRejectedValue(offline);
    const destination = join(root, "offline");
    await expect(prepareNginxSource(destination)).rejects.toBe(offline);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    fetcher.mockRestore();
  }
});
