import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";

import Ajv, { type ErrorObject, type JSONSchemaType } from "ajv";

import type {
  HomePublicationInput,
  VerifiedAsset,
  VerifiedPublicationInput,
} from "../../model/publication";

interface ManifestFile {
  readonly path: string;
  readonly mediaType: "application/json" | "image/png";
  readonly sha256: string;
}

interface PublicationManifest {
  readonly schemaVersion: 1;
  readonly publicationId: string;
  readonly builderCompatibility: {
    readonly min: string;
    readonly maxExclusive: string;
  };
  readonly entrypoints: { readonly home: string };
  readonly files: readonly ManifestFile[];
}

const BUILDER_VERSION = "0.1.0";
const manifestSchemaPath = join(
  process.cwd(),
  "contracts",
  "publication-manifest.schema.json",
);
const homeSchemaPath = join(process.cwd(), "contracts", "home-page.schema.json");

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const loadSchema = async <T>(path: string): Promise<JSONSchemaType<T>> =>
  (await readJson(path)) as JSONSchemaType<T>;

const formatErrors = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");

const compareVersion = (left: string, right: string): number => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const assertSafePath = (path: string): void => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`manifest contains unsafe path: ${path}`);
  }
};

const listFiles = async (root: string, directory = root): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`publication input must not contain symlinks: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      paths.push(...(await listFiles(root, fullPath)));
    } else if (entry.isFile()) {
      paths.push(relative(root, fullPath).split(sep).join("/"));
    } else {
      throw new Error(`publication input contains unsupported file type: ${entry.name}`);
    }
  }
  return paths.sort();
};

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const validatePublicationInput = async (
  inputRoot: string,
): Promise<VerifiedPublicationInput> => {
  const root = resolve(inputRoot);
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validateManifest = ajv.compile<PublicationManifest>(
    await loadSchema<PublicationManifest>(manifestSchemaPath),
  );
  const validateHome = ajv.compile<HomePublicationInput>(
    await loadSchema<HomePublicationInput>(homeSchemaPath),
  );

  const rawManifest = await readJson(join(root, "manifest.json"));
  if (!validateManifest(rawManifest)) {
    throw new Error(
      `invalid publication manifest: ${formatErrors(validateManifest.errors)}`,
    );
  }
  const manifest = rawManifest;

  if (
    compareVersion(BUILDER_VERSION, manifest.builderCompatibility.min) < 0 ||
    compareVersion(BUILDER_VERSION, manifest.builderCompatibility.maxExclusive) >= 0
  ) {
    throw new Error(`publication is incompatible with builder ${BUILDER_VERSION}`);
  }

  const declaredPaths = new Set<string>();
  for (const file of manifest.files) {
    assertSafePath(file.path);
    if (declaredPaths.has(file.path)) {
      throw new Error(`manifest declares duplicate file: ${file.path}`);
    }
    declaredPaths.add(file.path);
  }

  const actualPaths = await listFiles(root);
  const expectedPaths = ["manifest.json", ...declaredPaths].sort();
  if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error(
      `publication file set differs from manifest; expected ${expectedPaths.join(", ")}; found ${actualPaths.join(", ")}`,
    );
  }

  const assets = new Map<string, VerifiedAsset>();
  for (const file of manifest.files) {
    const fullPath = join(root, file.path);
    const metadata = await stat(fullPath);
    if ((metadata.mode & 0o111) !== 0) {
      throw new Error(`publication input file must not be executable: ${file.path}`);
    }
    const actualHash = sha256(await readFile(fullPath));
    if (actualHash !== file.sha256) {
      throw new Error(`sha256 mismatch for ${file.path}`);
    }
    if (file.path.startsWith("assets/")) {
      if (
        file.mediaType !== "image/png" ||
        file.path !== `assets/sha256/${file.sha256}.png`
      ) {
        throw new Error(`asset path is not content addressed: ${file.path}`);
      }
      assets.set(file.path, {
        path: file.path,
        fullPath,
        mediaType: file.mediaType,
        sha256: file.sha256,
      });
    }
  }

  assertSafePath(manifest.entrypoints.home);
  const homeFile = manifest.files.find((file) => file.path === manifest.entrypoints.home);
  if (homeFile?.mediaType !== "application/json") {
    throw new Error("home entrypoint must reference a declared JSON file");
  }
  const rawHome = await readJson(join(root, manifest.entrypoints.home));
  if (!validateHome(rawHome)) {
    throw new Error(`invalid home page input: ${formatErrors(validateHome.errors)}`);
  }
  const home = rawHome;
  if (!assets.has(home.masthead.logoAssetPath)) {
    throw new Error("home page logoAssetPath must reference a declared PNG asset");
  }

  return Object.freeze({
    root,
    publicationId: manifest.publicationId,
    home: Object.freeze(home),
    assets,
  });
};
