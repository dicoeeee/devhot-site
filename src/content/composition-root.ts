import { join } from "node:path";

import { createPublicationInputRepository } from "./adapters/publication-input/publication-input-repository";
import { validatePublicationInput } from "./adapters/publication-input/validate-publication-input";
import type { SiteContentRepository } from "./ports/site-content-repository";

export const createSiteContentRepository = async (
  inputRoot = join(process.cwd(), "site-input"),
): Promise<SiteContentRepository> => {
  const verifiedInput = await validatePublicationInput(inputRoot);
  return createPublicationInputRepository(verifiedInput);
};
