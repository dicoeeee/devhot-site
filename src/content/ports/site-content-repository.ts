import type { HomePage } from "../model/home-page";

export interface SiteContentRepository {
  getHome(): Promise<HomePage>;
}
