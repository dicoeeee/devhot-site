import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { afterAll, onTestFinished } from "vitest";

// 构建目录统一登记；文件级 afterAll 兜底回收。
const createdBuildRoots: string[] = [];
afterAll(async () => {
  const failures: Error[] = [];
  while (createdBuildRoots.length > 0) {
    const root = createdBuildRoots.pop()!;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "static build cleanup failed");
  }
});
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = process.cwd();

export const prepareStaticBuild = async (inputRoot: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "devhot-site-page-"));
  createdBuildRoots.push(root);
  try {
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
  } catch {
    // 钩子上下文：交给 afterAll 兜底。
  }
  await Promise.all(
    ["contracts", "public", "src"].map((path) =>
      cp(join(projectRoot, path), join(root, path), { recursive: true }),
    ),
  );
  await Promise.all(
    ["astro.config.mjs", "package.json", "tsconfig.json"].map((path) =>
      cp(join(projectRoot, path), join(root, path)),
    ),
  );
  await symlink(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  await symlink(inputRoot, join(root, "site-input"), "dir");
  return root;
};
