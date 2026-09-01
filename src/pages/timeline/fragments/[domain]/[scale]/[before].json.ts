import type { APIRoute, GetStaticPaths } from "astro";

import { createSiteContentRepository } from "../../../../../content/composition-root";
import type { TimelineFragment } from "../../../../../content/model/timeline-page";

export const getStaticPaths = (async () => {
  const fragments = await (await createSiteContentRepository()).listTimelineFragments();
  return fragments.map((fragment) => ({
    params: {
      domain: fragment.domainId,
      scale: fragment.scale,
      before: fragment.before,
    },
    props: { fragment },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ fragment: TimelineFragment }> = ({ props }) =>
  new Response(JSON.stringify(props.fragment), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
