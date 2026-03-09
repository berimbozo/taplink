export interface Review {
  id: string;
  author: string;
  avatar: string | null;
  rating: number;
  date: string;
  text: string;
  pinned: boolean;
  aiPicked: boolean;
}

export interface WidgetConfig {
  accentColor: string;
  bgColor: string;
  textColor: string;
  showStars: boolean;
  showPhoto: boolean;
  showName: boolean;
  showBadge: boolean;
  displayStyle: "carousel" | "row" | "grid" | "list";
  maxReviews: number;
  minRating: number;
  ctaEnabled: boolean;
  ctaText: string;
  ctaLink: string;
  ctaColor: string;
  reviewSource: "google" | "outscraper";
  refreshSchedule: "manual" | "weekly";
  autoAiPick: boolean;
  showSectionTitle: boolean;
  sectionTitle: string;
  reviewMaxChars: number;
  showMoreButton: boolean;
}

export interface CacheEntry {
  reviews: Review[];
  overallRating: number;
  totalReviews: number;
  source: string;
  fetchedAt: Date;
}

export interface AiPickResult {
  picks: number[];
  reasoning: string;
}

export interface RefreshResult {
  reviewCount: number;
}
