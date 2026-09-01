import { describe, expect, it } from "vitest";

import { createSiteContentRepository } from "../../src/content/composition-root";
import { createPublicationInputRepository } from "../../src/content/adapters/publication-input/publication-input-repository";
import { validatePublicationInput } from "../../src/content/adapters/publication-input/validate-publication-input";
import { writePublicationFixture } from "../support/publication-fixture";

describe("timeline repository", () => {
  it("builds bounded daily and complete-week fragments with builder-owned cursors", async () => {
    const fixture = await writePublicationFixture();
    const repository = await createSiteContentRepository(fixture.root);

    const timelines = await repository.listTimelines();
    const software = timelines.find(
      (timeline) => timeline.domain.id === "software-engineering",
    );

    expect(software?.fragments.day).toHaveLength(2);
    expect(software?.fragments.day[0]).toMatchObject({
      identity: "software-engineering:day:2026-08-15",
      before: "2026-08-15",
      nextBefore: "2026-08-10",
      hasMore: true,
      groups: [{ kind: "day", date: "2026-08-19" }],
    });
    expect(software?.fragments.day[1]).toMatchObject({
      before: "2026-08-10",
      hasMore: false,
      groups: [{ kind: "day", date: "2026-08-13" }],
    });
    expect(software?.fragments.week.map((fragment) => fragment.before)).toEqual([
      "2026-08-10",
      "2026-08-03",
    ]);
    expect(software?.fragments.week[0]).toMatchObject({
      nextBefore: "2026-08-03",
      groups: [
        {
          kind: "week",
          weekStart: "2026-08-10",
          weekEnd: "2026-08-16",
        },
      ],
    });
  });

  it("fails the build instead of truncating a fragment above 256 KiB", async () => {
    const fixture = await writePublicationFixture();
    const input = await validatePublicationInput(fixture.root);
    const repository = createPublicationInputRepository({
      ...input,
      insights: input.insights.map((insight, index) =>
        index === 0 ? { ...insight, summary: "x".repeat(256 * 1024) } : insight,
      ),
    });

    await expect(repository.listTimelines()).rejects.toThrow(
      /timeline fragment limit exceeded: .*bytes=/,
    );
  });
});
