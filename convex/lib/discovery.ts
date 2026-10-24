// Picks which search results are worth crawling for robot specs.

// Sites that rarely have a vendor's own spec sheet.
const SKIP_HOSTS = [
  "youtube.com", "reddit.com", "amazon.com", "ebay.com", "wikipedia.org", "linkedin.com",
  "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "pinterest.com", "quora.com",
];

export function searchQueries(task: string, searchPhrase: string): string[] {
  return [`${searchPhrase} robot`, `autonomous ${task} robot price`, `${task} robot specifications commercial`];
}

type SerpPage = { organicResults?: { url?: string }[] };

// One URL per website, skipping social and shopping sites, best-ranked first.
export function pickUrls(serpPages: SerpPage[], max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const page of serpPages) {
    for (const r of page.organicResults ?? []) {
      if (!r.url) continue;
      let host: string;
      try {
        host = new URL(r.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (SKIP_HOSTS.some((h) => host === h || host.endsWith("." + h)) || seen.has(host)) continue;
      seen.add(host);
      out.push(r.url);
      if (out.length >= max) return out;
    }
  }
  return out;
}
