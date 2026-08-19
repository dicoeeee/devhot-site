import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const listSafeFiles = async (
  root: string,
  scope: string,
  directory = root,
): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${scope} must not contain symlinks: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      paths.push(...(await listSafeFiles(root, scope, fullPath)));
    } else if (entry.isFile()) {
      paths.push(relative(root, fullPath).split(sep).join("/"));
    } else {
      throw new Error(`${scope} contains unsupported file type: ${entry.name}`);
    }
  }
  return paths.sort();
};
