import { cp, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = process.cwd();

export const prepareStaticBuild = async (inputRoot: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "devhot-site-page-"));
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
