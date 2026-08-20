import type { HomePage } from "../model/home-page";
import type { InsightPage } from "../model/insight-page";
import type { SourceArchivePage } from "../model/source-archive-page";

export interface SiteContentRepository {
  getHome(domainId?: string): Promise<HomePage>;
  listHomes(): Promise<readonly HomePage[]>;
  listInsights(): Promise<readonly InsightPage[]>;
  listSourceArchives(): Promise<readonly SourceArchivePage[]>;
}
