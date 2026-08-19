import type { HomePage } from "../../model/home-page";
import type { VerifiedPublicationInput } from "../../model/publication";
import type { SiteContentRepository } from "../../ports/site-content-repository";

export const createPublicationInputRepository = (
  input: VerifiedPublicationInput,
): SiteContentRepository => ({
  async getHome(): Promise<HomePage> {
    const { home } = input;
    const logo = input.assets.get(home.masthead.logoAssetPath);
    if (!logo) {
      throw new Error("verified home logo is unavailable");
    }

    return {
      domain: { ...home.domain },
      brand: {
        publication: home.masthead.publication,
        journal: home.masthead.journal,
        attribution: home.masthead.attribution,
        logoUrl: `/media/sha256/${logo.sha256}.png`,
      },
      status: { ...home.status },
      intro: { ...home.intro },
    };
  },
});
