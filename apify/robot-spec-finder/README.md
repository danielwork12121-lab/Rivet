# Robot Spec Finder

Give it a job, like **"gutter cleaning"** or **"commercial mowing"**, and it returns the robots that do it, with price and specs **quoted from each vendor's own page**.

Built for small trade businesses (lawn care, cleaning, pest control, facilities) that want to know whether a robot could take over a job, without trusting a chatbot's guesses.

## How it works

1. **Finds vendor pages** with [Google Search Results Scraper](https://apify.com/apify/google-search-scraper), keeping one page per website and skipping YouTube, Amazon and social sites. Or you give it the pages.
2. **Reads each page** with [Website Content Crawler](https://apify.com/apify/website-content-crawler).
3. **Extracts the robot** with Claude Haiku, which must copy the exact sentence behind every number.
4. **Checks every number in code.** A spec is kept only if its quote is really on the page and contains the number. Units are converted by code (acres per hour to sq ft per hour, lbs to kg, minutes to hours). Anything that fails is left out, not guessed.

## Input

| Field | Example |
|---|---|
| `task` | `gutter cleaning` |
| `searchPhrase` (optional) | `gutter cleaning robot` |
| `startUrls` (optional) | vendor product pages to read instead of searching |
| `maxSites` | `8` |
| `anthropicApiKey` | your key, stored encrypted |

## Output

One row per robot. Every price and spec has its own column, so the table view and CSV or Excel exports are ready to use.

| Column | Example |
|---|---|
| `name`, `vendor`, `task`, `url` | Example Mower X1, Example Robotics, commercial mowing, source page |
| `priceAvailable` | `true` |
| `pricingModel` | `purchase`, `subscription` or `none` |
| `priceSummary` | "$799 per month ($9,588 a year), no purchase price listed" |
| `purchasePriceUsd` | `18500` or empty |
| `subscriptionBilled` | `monthly` or `yearly` |
| `monthlySubscriptionUsd` | `799` |
| `annualSubscriptionUsd` | `9588` |
| `yearlyCostToRunUsd` | `9588` |
| `laborReplacedPercent` | `60` |
| `runtimeHours`, `maxSlopeDegrees`, `coverageSqftPerHour`, `payloadKg`, `tankLiters`, `reachMeters`, `workingWidthMeters`, `weightKg` | one column per spec, empty if the page doesn't say |
| `priceQuote` | the sentence on the page the price came from |
| `specSources` | each spec with its quote |
| `estimates` | every number we estimated because the page didn't say |
| `specs` | full detail with a source URL per spec |
| `checkedAt` | when the page was read |

### Pricing

`pricing.model` is one of:

- **`purchase`**: a one-time price is listed. If the robot also needs a subscription, it's in `subscription` and counted in `yearlyOpex`.
- **`subscription`**: no purchase price, but a monthly or yearly subscription, lease or robot-as-a-service plan is listed. `perYear` is worked out by code.
- **`none`**: no public price. `note` says "No public price available. Contact the vendor for a quote." and `yearlyOpex` is `null`.

Every price, like every spec, is kept only if its quote is on the page. `assumptions` lists every number we had to estimate because the page didn't say.

Spec names: `runtime_hours`, `max_slope_deg`, `coverage_sqft_per_hour`, `payload_kg`, `tank_liters`, `reach_m`, `width_m`, `weight_kg`.

## Cost

Each run calls two Apify Actors (a few cents for 8 pages) and Claude Haiku (well under a cent per page, on your Anthropic key).

Made at Cal Hacks for **Rivet**, a marketplace where small businesses find robots or pool bounties to get new ones built.
