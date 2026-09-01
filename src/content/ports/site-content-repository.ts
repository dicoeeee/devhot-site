import type { HomePage } from "../model/home-page";
import type { InsightPage } from "../model/insight-page";
import type { SourceArchivePage } from "../model/source-archive-page";
import type { TagPage } from "../model/tag-page";
import type { TimelineFragment, TimelinePage } from "../model/timeline-page";
import type { TopicOverviewPage, TopicPage } from "../model/topic-page";

export interface SiteContentRepository {
  getHome(domainId?: string): Promise<HomePage>;
  listHomes(): Promise<readonly HomePage[]>;
  listInsights(): Promise<readonly InsightPage[]>;
  listSourceArchives(): Promise<readonly SourceArchivePage[]>;
  listTopicOverviews(): Promise<readonly TopicOverviewPage[]>;
  listTopicPages(): Promise<readonly TopicPage[]>;
  listTagPages(): Promise<readonly TagPage[]>;
  listTimelines(): Promise<readonly TimelinePage[]>;
  listTimelineFragments(): Promise<readonly TimelineFragment[]>;
}
