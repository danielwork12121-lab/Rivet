// Runs the real main.ts with the Apify SDK and the Anthropic SDK replaced by stubs, so nothing
// touches the network. Checks the crawlOnly contract Rivet's backend relies on: no key needed,
// page rows in the agreed format, and no AI call. TEST FIXTURES only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXIT = "actor-exit";
const FAIL = "actor-fail";
const anthropicCtor = vi.fn();
const parse = vi.fn();
const actor = {
  init: vi.fn(async () => {}),
  getInputOrThrow: vi.fn(),
  setStatusMessage: vi.fn(async () => {}),
  call: vi.fn(),
  newClient: vi.fn(),
  pushData: vi.fn(async () => {}),
  exit: vi.fn(async () => { throw new Error(EXIT); }), // the real one ends the process
  fail: vi.fn(async () => { throw new Error(FAIL); }),
};

vi.mock("apify", () => ({ Actor: actor, log: { info: vi.fn(), warning: vi.fn() } }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { parse }; constructor(opts: unknown) { anthropicCtor(opts); } },
}));
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({ zodOutputFormat: () => ({}) }));

const longText = "It mows steep slopes and runs four hours. ".repeat(12); // over the 200-character floor
const crawled = [
  { url: "https://acme.example/x1", markdown: longText,
    metadata: { title: "Acme X1", openGraph: [{ property: "og:image", content: "/img/x1.jpg" }] } },
  { url: "https://acme.example/text-only", text: longText },
  { url: "https://blocked.example", markdown: "403 Forbidden" }, // too short: dropped
  { markdown: longText }, // no url: dropped
];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  actor.call.mockResolvedValue({ defaultDatasetId: "ds-crawl" });
  actor.newClient.mockReturnValue({ dataset: () => ({ listItems: async () => ({ items: crawled }) }) });
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => vi.unstubAllEnvs());

const run = async (input: Record<string, unknown>) => {
  actor.getInputOrThrow.mockResolvedValue({ task: "mowing", startUrls: [{ url: "https://acme.example/x1" }], ...input });
  await import("./main.js").catch((e) => { if (![EXIT, FAIL].includes(String(e.message))) throw e; });
};

describe("crawlOnly", () => {
  it("needs no Anthropic key, returns { url, title, markdown, imageUrl } rows, and never creates a Claude client", async () => {
    await run({ crawlOnly: true });
    expect(actor.fail).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(actor.pushData).toHaveBeenCalledTimes(1);
    expect(actor.pushData.mock.calls[0][0]).toEqual([
      { url: "https://acme.example/x1", title: "Acme X1", markdown: longText, imageUrl: "https://acme.example/img/x1.jpg" },
      { url: "https://acme.example/text-only", title: "", markdown: longText, imageUrl: null },
    ]);
    expect(actor.exit).toHaveBeenCalledWith(expect.stringMatching(/Crawled 2 of 1 pages.*Nothing was sent to an AI model/));
  });

  it("ignores a key if one is supplied anyway, and still makes no AI call", async () => {
    await run({ crawlOnly: true, anthropicApiKey: "sk-ant-TEST-ignored" });
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(JSON.stringify(actor.pushData.mock.calls)).not.toContain("sk-ant-TEST-ignored");
  });

  it("caps each page at 200,000 characters", async () => {
    actor.newClient.mockReturnValue({ dataset: () => ({ listItems: async () => ({ items: [{ url: "https://big.example", markdown: "x".repeat(250_000) }] }) }) });
    await run({ crawlOnly: true });
    expect((actor.pushData.mock.calls[0][0] as { markdown: string }[])[0].markdown).toHaveLength(200_000);
  });
});

describe("legacy manual run (no crawlOnly)", () => {
  it("still takes the key from the input and reads pages with Claude", async () => {
    parse.mockResolvedValue({ parsed_output: { robots: [] } });
    await run({ anthropicApiKey: "sk-ant-TEST-manual" });
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: "sk-ant-TEST-manual" });
    expect(parse).toHaveBeenCalled();
    expect(actor.fail).not.toHaveBeenCalled();
  });

  it("fails fast, before crawling, when there is no key at all", async () => {
    await run({});
    expect(actor.fail).toHaveBeenCalledWith(expect.stringMatching(/Anthropic API key.*crawlOnly/));
    expect(actor.call).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });
});
