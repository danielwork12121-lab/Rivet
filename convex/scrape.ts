"use node";
// Every Apify call lives in this file. Apify runs ready-made scrapers ("Actors")
// in the cloud; we start them and read their results. Needs APIFY_TOKEN in the
// Convex environment: npx convex env set APIFY_TOKEN 'apify_api_...'
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pickUrls, searchQueries } from "./lib/discovery";
import { normalizeTask } from "./lib/decide";
import { callActor, datasetItems, getRun, isBusy, isRunning, startActor } from "./lib/apify";
import { robotFromActorRow, type ActorRow } from "./lib/actorRows";
import { pageImage, type CrawledPage } from "./lib/images";

const WAIT_SECS = 240; // Convex actions stop after 10 minutes; each Actor gets at most 4

// Our own Robot Spec Finder Actor, e.g. "yourname/robot-spec-finder". When it is set,
// searches run on it instead of the built-in Google -> crawl steps:
// npx convex env set APIFY_ACTOR_ID 'yourname/robot-spec-finder'
// It runs with crawlOnly: it finds and crawls the vendor pages and returns their text. Claude
// reads them here (ai.extractPages), so ANTHROPIC_API_KEY never goes into an Apify run's input,
// which Apify stores and shows. The Actor must be a version that has the crawlOnly input.
const finderActor = () => process.env.APIFY_ACTOR_ID;
const CHECK_EVERY_MS = 30_000;
const BUSY_WAIT_MS = 30_000; // Apify's concurrent-run limit: wait this long, then try again
const BUSY_RETRY_MS = 8 * 60 * 1000; // ...for at most this long after the search was created
const GIVE_UP_MS = 14 * 60 * 1000; // discovery.ts treats a search older than 15 minutes as crashed

// Google search -> pick vendor pages -> crawl them -> hand over to extraction.
export const discover = internalAction({
  args: { discoveryId: v.id("discoveries") },
  handler: async (ctx, { discoveryId }) => {
    const d = await ctx.runQuery(internal.discovery.get, { discoveryId });
    if (!d) return;
    try {
      const actorId = finderActor();
      if (actorId) {
        // Start it and check back, because one run can take longer than an action may.
        // If Apify refuses to start it (e.g. an old version that still wants a key, or a wrong
        // Actor id), fall back to the built-in steps below so the search still happens.
        const run = await startActor(actorId, {
          task: d.task,
          searchPhrase: d.searchPhrase,
          crawlOnly: true, // no AI inside Apify, so no key in the input
          maxSites: Number(process.env.APIFY_MAX_SITES) || 8, // pages to read; more = slower but more robots
        }).catch((err) => {
          if (isBusy(err)) throw err; // wait for a free slot (below), don't switch paths
          console.warn(`Robot Spec Finder (${actorId}) wouldn't start, using the built-in search: ${String(err).slice(0, 300)}`);
          return null;
        });
        if (run) {
          await ctx.runMutation(internal.discovery.setStatus, { discoveryId, status: "crawling" });
          await ctx.scheduler.runAfter(CHECK_EVERY_MS, internal.scrape.checkFinderRun, {
            discoveryId, runId: run.id, startedAt: Date.now(),
          });
          return;
        }
      }
      const run = await callActor(
        "apify/google-search-scraper",
        { queries: searchQueries(d.task, d.searchPhrase).join("\n"), maxPagesPerQuery: 1, countryCode: "us" },
        WAIT_SECS,
      );
      const items = await datasetItems(run.defaultDatasetId);
      const urls = pickUrls(items as { organicResults?: { url?: string }[] }[]);
      await crawlAndExtract(ctx, discoveryId, urls);
    } catch (err) {
      // Apify is running too many jobs at once: try again shortly, while the search is still young.
      if (isBusy(err) && Date.now() - d._creationTime < BUSY_RETRY_MS) {
        await ctx.scheduler.runAfter(BUSY_WAIT_MS, internal.scrape.discover, { discoveryId });
        return;
      }
      await ctx.runMutation(internal.discovery.finish, {
        discoveryId, status: "failed", robotsFound: 0, error: String(err).slice(0, 500),
      });
    }
  },
});

// Pre-load a task from vendor pages you picked yourself, skipping the Google step:
// npx convex run scrape:crawlUrls '{"task":"mowing","urls":["https://...","https://..."]}'
export const crawlUrls = internalAction({
  args: { task: v.string(), urls: v.array(v.string()) },
  handler: async (ctx, { task, urls }) => {
    const discoveryId = await ctx.runMutation(internal.discovery.startManual, { task });
    try {
      await crawlAndExtract(ctx, discoveryId, urls);
      return "Crawled. Robots appear in the robots table once extraction finishes (about a minute).";
    } catch (err) {
      await ctx.runMutation(internal.discovery.finish, {
        discoveryId, status: "failed", robotsFound: 0, error: String(err).slice(0, 500),
      });
      throw err;
    }
  },
});

async function crawlAndExtract(ctx: ActionCtx, discoveryId: Id<"discoveries">, urls: string[]) {
  await ctx.runMutation(internal.discovery.setStatus, { discoveryId, status: "crawling", urls });
  if (urls.length > 0) {
    const run = await callActor(
      "apify/website-content-crawler",
      {
        startUrls: urls.map((url) => ({ url })),
        maxCrawlDepth: 0, // just these pages, no following links
        maxCrawlPages: urls.length,
        crawlerType: "playwright:adaptive", // plain HTTP when it can, a browser when the page needs JavaScript
        saveMarkdown: true,
        removeCookieWarnings: true,
      },
      WAIT_SECS,
    );
    await savePages(ctx, discoveryId, await datasetItems(run.defaultDatasetId));
  }
  await ctx.runMutation(internal.discovery.setStatus, { discoveryId, status: "extracting" });
  await ctx.scheduler.runAfter(0, internal.ai.extractPages, { discoveryId });
}

type PageItem = CrawledPage & { title?: string; metadata?: CrawledPage["metadata"] & { title?: string } };

// Stores crawled pages for ai.extractPages. Returns how many were usable.
async function savePages(ctx: ActionCtx, discoveryId: Id<"discoveries">, items: unknown[]): Promise<number> {
  let saved = 0;
  for (const item of items as PageItem[]) {
    const markdown = item.markdown ?? item.text ?? "";
    if (!item.url || markdown.length < 200) continue; // blocked or empty pages
    await ctx.runMutation(internal.discovery.savePage, {
      discoveryId, url: item.url, title: item.title ?? item.metadata?.title ?? "", markdown: markdown.slice(0, 200_000),
      ...(pageImage(item) ? { imageUrl: pageImage(item)! } : {}),
    });
    saved++;
  }
  return saved;
}

// ---------- Our Robot Spec Finder Actor ----------

// Checks on a finder run every 30 seconds. A crawlOnly run returns pages, which go to Claude here;
// a run made by hand with its own key (importFinderRun) returns finished robot rows instead.
export const checkFinderRun = internalAction({
  args: { discoveryId: v.id("discoveries"), runId: v.string(), startedAt: v.number() },
  handler: async (ctx, { discoveryId, runId, startedAt }) => {
    const run = await getRun(runId);
    if (isRunning(run) && Date.now() - startedAt < GIVE_UP_MS) {
      await ctx.scheduler.runAfter(CHECK_EVERY_MS, internal.scrape.checkFinderRun, { discoveryId, runId, startedAt });
      return;
    }
    if (run.status !== "SUCCEEDED") {
      await ctx.runMutation(internal.discovery.finish, {
        discoveryId, status: "failed", robotsFound: 0, error: `Apify run ${runId} ended as ${run.status}`,
      });
      return;
    }
    const d = await ctx.runQuery(internal.discovery.get, { discoveryId });
    if (!d) return;
    const items = await datasetItems(run.defaultDatasetId);
    const isPage = (i: unknown) => typeof (i as PageItem).markdown === "string" && !(i as ActorRow).name;
    if (items.some(isPage)) {
      const pages = await savePages(ctx, discoveryId, items.filter(isPage));
      if (pages > 0) {
        await ctx.runMutation(internal.discovery.setStatus, { discoveryId, status: "extracting" });
        await ctx.scheduler.runAfter(0, internal.ai.extractPages, { discoveryId });
        return;
      }
      await ctx.runMutation(internal.discovery.finish, { discoveryId, status: "done", robotsFound: 0 });
      return;
    }
    const found = await saveActorRows(ctx, items, d.task);
    await ctx.runMutation(internal.discovery.finish, { discoveryId, status: "done", robotsFound: found });
  },
});

// Load the results of a run you started on the Apify website:
// npx convex run scrape:importFinderRun '{"task":"mowing","runId":"<run ID from the Apify run page>"}'
export const importFinderRun = internalAction({
  args: { task: v.string(), runId: v.string() },
  handler: async (ctx, { task, runId }): Promise<string> => {
    const run = await getRun(runId);
    const discoveryId: Id<"discoveries"> = await ctx.runMutation(internal.discovery.startManual, { task });
    const found = await saveActorRows(ctx, await datasetItems(run.defaultDatasetId), normalizeTask(task));
    await ctx.runMutation(internal.discovery.finish, { discoveryId, status: "done", robotsFound: found });
    return `Saved ${found} robots for "${normalizeTask(task)}"`;
  },
});

async function saveActorRows(ctx: ActionCtx, items: unknown[], task: string): Promise<number> {
  let found = 0;
  for (const item of items as ActorRow[]) {
    const robot = robotFromActorRow(item, task);
    if (!robot) continue;
    await ctx.runMutation(internal.robots.upsertScraped, robot);
    found++;
  }
  return found;
}
