// A small client for Apify's REST API (https://docs.apify.com/api/v2), using plain
// fetch. The apify-client package crashed when bundled into Convex, so we don't use it.

const BASE = "https://api.apify.com/v2";

export type ApifyRun = { id: string; status: string; defaultDatasetId: string };

// "username/actor-name" in URLs is written "username~actor-name"; plain IDs pass through.
const actorPath = (actorId: string) => encodeURIComponent(actorId.trim().replace("/", "~"));

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN is not set in Convex");
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Apify ${init.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Starts a run and returns at once.
export async function startActor(actorId: string, input: unknown): Promise<ApifyRun> {
  const body = (await api(`/acts/${actorPath(actorId)}/runs`, { method: "POST", body: JSON.stringify(input) })) as { data: ApifyRun };
  return body.data;
}

// The run's current state. With waitSecs, Apify holds the answer until the run ends (at most 60s).
export async function getRun(runId: string, waitSecs = 0): Promise<ApifyRun> {
  const body = (await api(`/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${Math.min(waitSecs, 60)}`)) as { data: ApifyRun };
  return body.data;
}

const RUNNING = new Set(["READY", "RUNNING"]);
export const isRunning = (run: ApifyRun) => RUNNING.has(run.status);

// Starts a run and waits up to waitSecs for it to end. Like apify-client's call(),
// it returns the run even if it is still going, so the caller reads what's there.
export async function callActor(actorId: string, input: unknown, waitSecs: number): Promise<ApifyRun> {
  let run = await startActor(actorId, input);
  const until = Date.now() + waitSecs * 1000;
  while (isRunning(run) && Date.now() < until) {
    run = await getRun(run.id, Math.ceil((until - Date.now()) / 1000));
  }
  return run;
}

export async function datasetItems(datasetId: string): Promise<unknown[]> {
  return (await api(`/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json`)) as unknown[];
}
