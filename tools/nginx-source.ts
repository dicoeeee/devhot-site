import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const NGINX_VERSION = "1.30.4";
export const NGINX_TARBALL_SHA256 =
  "4261dc90e9e47c1c4041276e9aaa3d48ebe2e664f728e14fa95ae6c67d57a08b";
const SOURCE_URL = `https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz`;
const MAX_BYTES = 8 * 1024 * 1024;

const verified = (bytes: Buffer): Buffer => {
  if (createHash("sha256").update(bytes).digest("hex") !== NGINX_TARBALL_SHA256) {
    throw new Error("pinned nginx tarball sha256 mismatch");
  }
  return bytes;
};

const download = async (): Promise<Buffer> => {
  const response = await fetch(SOURCE_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("deployment_nginx_source_unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("deployment_nginx_source_unavailable");
    }
    chunks.push(value);
  }
  return verified(Buffer.concat(chunks));
};

// Prepared inputs share only authenticated source bytes. Every runtime still
// compiles into its own process-owned root and verifies its binary and recipe.
export const readNginxSource = async (
  path: string | undefined = process.env.DEVHOT_NGINX_SOURCE_TARBALL,
): Promise<Buffer> => {
  if (path === undefined) return download();
  if (!isAbsolute(path)) throw new Error("deployment_invalid_nginx_source_path");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_BYTES)
      throw new Error("deployment_invalid_nginx_source");
    const chunks: Buffer[] = [];
    const block = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(block, 0, block.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_BYTES) throw new Error("deployment_invalid_nginx_source");
      chunks.push(Buffer.from(block.subarray(0, bytesRead)));
    }
    return verified(Buffer.concat(chunks));
  } finally {
    await file.close();
  }
};

// Called during preparation, once per attempt. A failed fetch leaves no input;
// bounded preparation retries belong to the deployment controller, not here.
export const prepareNginxSource = async (path: string): Promise<void> => {
  if (!isAbsolute(path)) throw new Error("deployment_invalid_nginx_source_path");
  const bytes = await download();
  const file = await open(path, "wx", 0o444);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(path);
    throw error;
  }
  await file.close();
};
