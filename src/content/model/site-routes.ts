export const insightRoute = (id: string): string => `/insights/${id}/`;

export const sourceArchiveRoute = (id: string): string => `/sources/${id}/`;

export const mediaAssetRoute = (sha256: string): string => `/media/sha256/${sha256}.png`;
