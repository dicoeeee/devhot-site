import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = process.cwd();

const listSourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await listSourceFiles(fullPath)));
    if (entry.isFile() && /\.(?:astro|ts)$/.test(entry.name)) paths.push(fullPath);
  }
  return paths;
};

export const checkArchitecture = async (): Promise<void> => {
  const presentationRoots = ["pages", "layouts", "components"].map((directory) =>
    join(projectRoot, "src", directory),
  );
  const files: string[] = [];
  for (const root of presentationRoots) {
    try {
      files.push(...(await listSourceFiles(root)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const forbiddenPatterns = [
    { pattern: /site-input\//, reason: "physical publication input" },
    { pattern: /from ["']node:fs/, reason: "filesystem API" },
    { pattern: /content\/adapters\//, reason: "static content adapter" },
    { pattern: /manifest\.json/, reason: "physical manifest" },
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.pattern.test(source)) {
        throw new Error(
          `${relative(projectRoot, file)} imports ${forbidden.reason} outside the composition root`,
        );
      }
    }
  }

  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  ) as { readonly scripts?: Record<string, string> };
  const forbiddenScripts = [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "pregate",
    "postgate",
    "prebuild",
    "postbuild",
  ];
  for (const script of forbiddenScripts) {
    if (packageJson.scripts?.[script]) {
      throw new Error(`implicit npm lifecycle script is forbidden: ${script}`);
    }
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await checkArchitecture();
  console.log("Verified presentation dependency direction and npm script graph");
}
