# Rivet backend — frontend integration contract

Backend: Convex + TypeScript. No server of our own: the browser talks to Convex directly.

## Connecting from plain HTML/JavaScript

You need one value from the backend owner: the **deployment URL**. For local
development it is `http://127.0.0.1:3210` (the backend owner must have
`npx convex dev` running on their machine, so it is reachable only from that
machine). A cloud deployment will look like `https://<name>.convex.cloud`. The URL is
public (not a secret) and is the only configuration. There are no API keys and no auth yet, so **anyone with the URL can
call these functions**; fine for a hackathon demo.

CORS needs no setup: Convex accepts browser requests from any origin, so
`file://`, `localhost` and any hosting all work.

```html
<script type="module">
  // Pin the version to match package.json.
  import { ConvexHttpClient } from "https://esm.sh/convex@1.48.0/browser";

  const client = new ConvexHttpClient("http://127.0.0.1:3210"); // or the cloud URL

  // Submit
  const id = await client.mutation("requests:create", {
    title: "Inspect culvert interiors",
    description: "Culverts under Route 9 need yearly inspection.",
    environment: "Confined, wet, no GPS, 0.8m diameter",
    constraints: ["Must be tethered", "Under 5 kg"],
    cost: { currency: "USD", currentAnnualCost: 40000, budget: 25000 }, // optional
  });

  // Read
  const requests = await client.query("requests:list", { limit: 20 });
  const one = await client.query("requests:get", { id });
</script>
```

`ConvexHttpClient` is request/response (call again to refresh). For live updates
use `ConvexClient` from the same module (`client.onUpdate("requests:list", {}, cb)`).

Functions are addressed by string `"<file>:<export>"`.

### Errors
Failed calls reject the promise. Validation failures from `requests:create` are a
`ConvexError` whose **`err.data`** is a user-readable string, e.g.
`"title must not be empty"`. Show that:

```js
try {
  await client.mutation("requests:create", form);
} catch (err) {
  showError(typeof err.data === "string" ? err.data : "Something went wrong, try again.");
}
```
Do not rely on `err.message`: on cloud deployments it is redacted. Wrong argument
types (e.g. `constraints` not an array) are rejected with a generic error and have no `err.data`.

### Rendering user text safely
Titles, descriptions and constraints are stored as the operator typed them and are
**not** HTML-escaped. Render them with `element.textContent = ...`, never `innerHTML`.

## Functions

### `requests:create` (mutation)
| Arg | Type | Rules |
|---|---|---|
| `title` | string | required, trimmed, 1–120 chars |
| `description` | string | required, trimmed, 1–5000 |
| `environment` | string | required, trimmed, 1–2000 |
| `constraints` | string[] | required (may be `[]`), ≤20 items, each ≤500; blanks dropped |
| `cost` | object | optional |
| `cost.currency` | string | required if `cost` given; 3 letters (`"usd"` → `"USD"`) |
| `cost.currentAnnualCost` | number | optional, ≥0 |
| `cost.budget` | number | optional, ≥0 |
| `cost.notes` | string | optional, ≤1000 |

Returns: the new request's id (string).

### `requests:list` (query)
Args: `{ limit?: number }` (default 50, clamped to 1–100). Returns an array, newest first.

### `requests:get` (query)
Args: `{ id: string }`. Returns the request or `null`. A malformed id rejects.

### Returned request shape
```json
{
  "_id": "k17...",
  "_creationTime": 1760000000000,
  "title": "string",
  "description": "string",
  "environment": "string",
  "constraints": ["string"],
  "cost": { "currency": "USD", "currentAnnualCost": 40000, "budget": 25000, "notes": "optional" },
  "status": "submitted"
}
```
`cost` and its inner fields are absent (not null) when not provided.
`_creationTime` is milliseconds since the epoch. `status` is `"submitted"` or `"specified"`.

## For the AI teammate
The `requirementSpecs` table (see `convex/schema.ts`) defines where extracted
requirements go. Nothing writes to it yet; a mutation/action will be added once the
extraction output shape is agreed.
