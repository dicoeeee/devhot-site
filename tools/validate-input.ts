import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { validatePublicationInput } from "../src/content/adapters/publication-input/validate-publication-input";

export const validateInput = async (inputRoot = join(process.cwd(), "site-input")) =>
  validatePublicationInput(inputRoot);

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const verified = await validateInput();
  console.log(
    `Validated publication ${verified.publicationId}: ${verified.assets.size} asset(s)`,
  );
}
