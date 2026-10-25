// Robot Spec Finder: give it a trade job ("gutter cleaning"), get back robots
// that do it, with specs whose every number is quoted from the vendor's page.
//
// 1. Google Search Results Scraper finds vendor pages (or you pass startUrls).
// 2. Website Content Crawler turns each page into text.
// 3. Claude Haiku reads each page and quotes the sentence behind every number.
// 4. Plain code keeps a number only if that quote is really on the page, and
//    converts units (acres/hour, lbs, minutes...) itself.
//
// crawlOnly: steps 1 and 2 only. The Actor returns each page's text ({ url, title, markdown })
// and never needs an Anthropic key; the caller reads the pages with Claude on its own side.
// Rivet's backend uses this, so its key is never put in a run's input or stored by Apify.
import { Actor, log } from "apify";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { pickUrls, searchQueries } from "./lib/discovery.js";
import { robotFromPage } from "./lib/extract.js";
import { pageImage, type CrawledPage } from "./lib/images.js";
import { toDatasetRow } from "./lib/row.js";
import { SPEC_NAMES } from "./lib/specs.js";

type Input = {
  task: string;
  searchPhrase?: string;
  startUrls?: { url: string }[];
  maxSites?: number;
  proxyConfiguration?: Record<string, unknown>;
  anthropicApiKey?: string;
  crawlOnly?: boolean;
};

const MODEL = "claude-haiku-5-5";

const EXTRACT_PROMPT = `You read one web page and list every robot product it describes, for a
marketplace that helps small trade businesses (lawn care, cleaning, pest control,
facilities, construction) find robots.
- robots: every robot or autonomous machine on the page that can be bought, leased or
  subscribed to, up to 15. A product page usually has one; a comparison, review, "best
  of" or category page can have several. Leave out manual equipment, accessories and
  spare parts. Return an empty list if there are none.
- Give each robot only the facts the page states about that robot.
- For every number, copy the exact sentence or table row from the page into quote, and
  give value and unit exactly as written there. If the page doesn't state it, use null
  for value, unit and quote. Never estimate or convert.
- price: one-time purchase price in USD.
- subscription: a recurring price in USD if the robot is offered as a subscription,
  lease, rental or robot-as-a-service plan, with subscriptionPeriod "month" or "year".
  If there are several plans, use the cheapest one that includes the robot. If the robot
  is bought and also needs a software or service subscription, give both.
- priceOnRequest: true if the page says to contact sales or request a quote.
- yearlyRunningCost: a stated yearly subscription, service plan or maintenance cost in USD.
- laborSavedPercent: a stated share of labor or time saved, e.g. "cuts labor by 60%" is 60.
- specs: only these names: ${SPEC_NAMES.join(", ")}.
- imageUrl: the URL of a photo of this robot exactly as it appears in the page text (an image
  link), or null. Not a logo or icon.`;

const Evidence = z.object({ value: z.number().nullable(), unit: z.string().nullable(), quote: z.string().nullable() });
const RobotSchema = z.object({
  name: z.string(),
  vendor: z.string(),
  priceOnRequest: z.boolean(),
  price: Evidence,
  subscription: Evidence,
  subscriptionPeriod: z.enum(["month", "year"]).nullable(),
  yearlyRunningCost: Evidence,
  laborSavedPercent: Evidence,
  specs: z.array(z.object({ name: z.enum(SPEC_NAMES), value: z.number(), unit: z.string(), quote: z.string() })),
  environments: z.array(z.string()),
  imageUrl: z.string().nullable(),
});
const PageSchema = z.object({ robots: z.array(RobotSchema) });

// Actor.call, but waits out Apify's "too many runs at once" refusal (the free plan allows 5
// concurrent runs, and several searches can start together) instead of failing the whole run.
async function callWhenFree(actorId: string, runInput: Record<string, unknown>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Actor.call(actorId, runInput);
    } catch (err) {
      const e = err as { statusCode?: number; type?: string };
      const busy = e?.statusCode === 402 || e?.type === "concurrent-runs-limit-exceeded";
      if (!busy || attempt >= 30) throw err;
      log.info(`Apify is at its concurrent-run limit; retrying ${actorId} in 20 s (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
}

await Actor.init();
const input = await Actor.getInputOrThrow<Input>();
const task = input.task?.trim();
const crawlOnly = input.crawlOnly === true;
const apiKey = crawlOnly ? undefined : input.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
if (!task) await Actor.fail("Input 'task' is required, e.g. \"gutter cleaning\".");
if (!crawlOnly && !apiKey) await Actor.fail("Add your Anthropic API key in the input (it's stored as a secret), or turn on crawlOnly.");
const maxSites = Math.min(Math.max(input.maxSites ?? 8, 1), 40);

// 1. Which pages to read
let urls = (input.startUrls ?? []).map((u) => u.url).filter(Boolean);
if (urls.length === 0) {
  await Actor.setStatusMessage(`Searching Google for ${task} robots`);
  const run = await callWhenFree("apify/google-search-scraper", {
    queries: searchQueries(task!, input.searchPhrase || `${task} robot`).join("\n"),
    maxPagesPerQuery: 1,
    countryCode: "us",
  });
  const { items } = await Actor.newClient().dataset(run.defaultDatasetId).listItems();
  urls = pickUrls(items as { organicResults?: { url?: string }[] }[], maxSites);
}
log.info(`Reading ${urls.length} pages`, { urls });

// 2. Page text
await Actor.setStatusMessage(`Crawling ${urls.length} vendor pages`);
const crawl = await callWhenFree("apify/website-content-crawler", {
  startUrls: urls.map((url) => ({ url })),
  maxCrawlDepth: 0,
  maxCrawlPages: urls.length,
  // Firefox through a residential proxy gets past most "403 Forbidden" bot walls.
  crawlerType: "playwright:firefox",
  proxyConfiguration: input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  maxRequestRetries: 3,
  saveMarkdown: true,
  removeCookieWarnings: true,
});
const { items: pages } = await Actor.newClient().dataset(crawl.defaultDatasetId).listItems();
const gotUrls = new Set((pages as { url?: string }[]).map((p) => p.url));
const blocked = urls.filter((u) => !gotUrls.has(u));
if (blocked.length) log.warning(`${blocked.length} sites blocked the crawler or failed`, { blocked });

// crawlOnly: hand the page text back; reading it is the caller's job (and the caller's key).
if (crawlOnly) {
  const rows = (pages as (CrawledPage & { metadata?: { title?: string } })[])
    .map((p) => ({
      url: p.url, title: p.metadata?.title ?? "", markdown: (p.markdown ?? p.text ?? "").slice(0, 200_000),
      imageUrl: pageImage(p), // the page's main photo (og:image or Product JSON-LD), or null
    }))
    .filter((p) => p.url && p.markdown.length >= 200); // blocked or empty pages
  await Actor.pushData(rows);
  await Actor.exit(`Crawled ${rows.length} of ${urls.length} pages for "${task}". Nothing was sent to an AI model.`);
}
const claude = new Anthropic({ apiKey });

// 3 + 4. Extract and verify. The same robot often appears on several pages (its
// own page and a few "best of" lists): keep one row, preferring the one with a price
// and then the one with more verified specs.
type Robot = NonNullable<ReturnType<typeof robotFromPage>>;
const robots = new Map<string, Robot>();
const key = (r: Robot) => r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const rank = (r: Robot) => (r.pricing.model !== "none" ? 100 : 0) + r.specs.length;
function addRobot(r: Robot): boolean {
  const old = robots.get(key(r));
  if (old && rank(old) >= rank(r)) return false;
  robots.set(key(r), r);
  return !old;
}
const found = () => robots.size;
for (const [i, item] of (pages as CrawledPage[]).entries()) {
  const markdown = item.markdown ?? item.text ?? "";
  if (!item.url || markdown.length < 200) continue;
  await Actor.setStatusMessage(`Reading page ${i + 1} of ${pages.length}, ${found()} robots so far`);
  try {
    const res = await claude.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "low", format: zodOutputFormat(PageSchema) },
      system: [{ type: "text", text: EXTRACT_PROMPT, cache_control: { type: "ephemeral" } }],
      // Product facts are near the top; the cap keeps one huge page from costing much.
      messages: [{ role: "user", content: `URL: ${item.url}\n\n${markdown.slice(0, 80_000)}` }],
    });
    const listed = res.parsed_output?.robots ?? [];
    let kept = 0;
    for (const r of listed.slice(0, 15)) {
      // A page's own photo only fits when it's about one robot.
      const imageUrl = listed.length === 1 ? pageImage(item) : null;
      const robot = robotFromPage({ ...r, isRobotProduct: true }, { url: item.url, markdown, imageUrl }, task!);
      if (robot && addRobot(robot)) kept++;
    }
    log.info(`${item.url}: ${listed.length} robots named, ${kept} new`);
  } catch (err) {
    log.warning(`Could not read ${item.url}: ${String(err).slice(0, 200)}`);
  }
}

const checkedAt = new Date().toISOString();
await Actor.pushData([...robots.values()].map((r) => toDatasetRow(r, checkedAt)));
await Actor.exit(`Found ${found()} robots for "${task}" from ${pages.length} pages. Every price and spec is quoted from its source page.`);
