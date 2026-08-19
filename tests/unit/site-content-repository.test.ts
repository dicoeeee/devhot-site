import { describe, expect, it } from "vitest";

import { createSiteContentRepository } from "../../src/content/composition-root";

describe("SiteContentRepository", () => {
  it("maps verified publication input into a stable home-page model", async () => {
    const repository = await createSiteContentRepository();

    const home = await repository.getHome();

    expect(home.domain).toEqual({
      id: "software-engineering",
      name: "软件工程",
      url: "/software-engineering/",
    });
    expect(home.brand.publication).toBe("DEVHOT");
    expect(home.brand.journal).toBe("INSIGHT JOURNAL");
    expect(home.brand.logoUrl).toMatch(/^\/media\/sha256\/[a-f0-9]{64}\.png$/);
  });
});
