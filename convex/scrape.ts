"use node";
// Every Apify call lives in this file. Apify runs ready-made scrapers ("Actors")
// in the cloud; we start them and read their results. Needs APIFY_TOKEN in the
// Convex environment: npx convex env set APIFY_TOKEN 'apify_api_...'
import { ApifyClient } from "apify-client";
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pickUrls, searchQueries } from "./lib/discovery";
import { normalizeTask } from "./lib/decide";
import { robotFromActorRow, type ActorRow } from "./lib/actorRows";

const apify = () => new ApifyClient({ token: process.env.APIFY_TOKEN });
const WAIT_SECS = 240; // Convex actions stop after 10 minutes; each Actor gets at most 4

// Our own Robot Spec Finder Actor, e.g. "yourname/robot-spec-finder". When it is set,
// searches run on it instead of the built-in Google -> crawl -> extract steps:
// npx convex env set APIFY_ACTOR_ID 'yourname/robot-spec-finder'
const finderActor = () => process.env.APIFY_ACTOR_ID;
const CHECK_EVERY_MS = 30_000;
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
        const run = await apify().actor(actorId).start({
          task: d.task,
          searchPhrase: d.searchPhrase,
          anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        });
        await ctx.runMutation(internal.discovery.setStatus, { discoveryId, status: "crawling" });
        await ctx.scheduler.runAfter(CHECK_EVERY_MS, internal.scrape.checkFinderRun, {
          discoveryId, runId: run.id, startedAt: Date.now(),
        });
        return;
      }
      const run = await apify().actor("apify/google-search-scraper").call(
        { queries: searchQueries(d.task, d.searchPhrase).join("\n"), maxPagesPerQuery: 1, countryCode: "us" },
        { waitSecs: WAIT_SECS },
      );
      const { items } = await apify().dataset(run.defaultDatasetId).listItems();
      const urls = pickUrls(items as { organicResults?: { url?: string }[] }[]);
      await crawlAndExtract(ctx, discoveryId, urls);
    } catch (err) {
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
    const run = await apify().actor("apify/website-content-crawler").call(
      {
        startUrls: urls.map((url) => ({ url })),
        maxCrawlDepth: 0, // just these pages, no following links
        maxCrawlPages: urls.length,
        crawlerType: "playwright:adaptive", // plain HTTP when it can, a browser when the page needs JavaScript
        saveMarkdown: true,
        removeCookieWarnings: true,
      },
      { waitSecs: WAIT_SECS },
    );
    const { items } = await apify().dataset(run.defaultDatasetId).listItems();
    for (const item of items as { url?: string; markdown?: string; text?: string; metadata?: { title?: string } }[]) {
      const markdown = item.markdown ?? item.text ?? "";
      if (!item.url || markdown.length < 200) continue; // blocked or empty pages
      await ctx.runMutation(internal.discovery.savePage, {
        discoveryId, url: item.url, title: item.metadata?.title ?? "", markdown: markdown.slice(0, 200_000),
      });
    }
  }
  await ctx.runMutation(internal.discovery.setStatus, { discoveryId, status: "extracting" });
  await ctx.scheduler.runAfter(0, internal.ai.extractPages, { discoveryId });
}

// ---------- Our Robot Spec Finder Actor ----------

// Checks on a finder run every 30 seconds; saves its robots when it finishes.
export const checkFinderRun = internalAction({
  args: { discoveryId: v.id("discoveries"), runId: v.string(), startedAt: v.number() },
  handler: async (ctx, { discoveryId, runId, startedAt }) => {
    const run = await apify().run(runId).get();
    const running = run?.status === "READY" || run?.status === "RUNNING";
    if (running && Date.now() - startedAt < GIVE_UP_MS) {
      await ctx.scheduler.runAfter(CHECK_EVERY_MS, internal.scrape.checkFinderRun, { discoveryId, runId, startedAt });
      return;
    }
    if (run?.status !== "SUCCEEDED") {
      await ctx.runMutation(internal.discovery.finish, {
        discoveryId, status: "failed", robotsFound: 0, error: `Apify run ${runId} ended as ${run?.status ?? "missing"}`,
      });
      return;
    }
    const d = await ctx.runQuery(internal.discovery.get, { discoveryId });
    if (!d) return;
    const found = await saveActorRows(ctx, run.defaultDatasetId, d.task);
    await ctx.runMutation(internal.discovery.finish, { discoveryId, status: "done", robotsFound: found });
  },
});

// Load the results of a run you started on the Apify website:
// npx convex run scrape:importFinderRun '{"task":"mowing","runId":"<run ID from the Apify run page>"}'
export const importFinderRun = internalAction({
  args: { task: v.string(), runId: v.string() },
  handler: async (ctx, { task, runId }): Promise<string> => {
    const run = await apify().run(runId).get();
    if (!run) throw new Error(`No Apify run ${runId}`);
    const discoveryId: Id<"discoveries"> = await ctx.runMutation(internal.discovery.startManual, { task });
    const found = await saveActorRows(ctx, run.defaultDatasetId, normalizeTask(task));
    await ctx.runMutation(internal.discovery.finish, { discoveryId, status: "done", robotsFound: found });
    return `Saved ${found} robots for "${normalizeTask(task)}"`;
  },
});

async function saveActorRows(ctx: ActionCtx, datasetId: string, task: string): Promise<number> {
  const { items } = await apify().dataset(datasetId).listItems();
  let found = 0;
  for (const item of items as ActorRow[]) {
    const robot = robotFromActorRow(item, task);
    if (!robot) continue;
    await ctx.runMutation(internal.robots.upsertScraped, robot);
    found++;
  }
  return found;
}
