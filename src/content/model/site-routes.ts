export const insightRoute = (id: string): string => `/insights/${id}/`;

export const sourceArchiveRoute = (id: string): string => `/sources/${id}/`;

export const topicOverviewRoute = (domainId: string): string => `/${domainId}/topics/`;

export const topicRoute = (id: string, topicPage = 1): string =>
  topicPage === 1 ? `/topics/${id}/` : `/topics/${id}/page/${topicPage}/`;

export const tagRoute = (type: string, name: string, tagPage = 1): string =>
  tagPage === 1 ? `/tags/${type}/${name}/` : `/tags/${type}/${name}/page/${tagPage}/`;

export const topicTagAnchor = (type: string, name: string): string =>
  `tag-${type}-${name}`;

export const mediaAssetRoute = (
  sha256: string,
  mediaType: "image/png" | "image/svg+xml" = "image/png",
): string => `/media/sha256/${sha256}.${mediaType === "image/svg+xml" ? "svg" : "png"}`;
