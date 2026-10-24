/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as ai from "../ai.js";
import type * as bounties from "../bounties.js";
import type * as discovery from "../discovery.js";
import type * as lib_decide from "../lib/decide.js";
import type * as lib_discovery from "../lib/discovery.js";
import type * as lib_drafts from "../lib/drafts.js";
import type * as lib_actorRows from "../lib/actorRows.js";
import type * as lib_extract from "../lib/extract.js";
import type * as lib_personas from "../lib/personas.js";
import type * as lib_roi from "../lib/roi.js";
import type * as lib_specs from "../lib/specs.js";
import type * as lib_validation from "../lib/validation.js";
import type * as lib_verify from "../lib/verify.js";
import type * as maintenance from "../maintenance.js";
import type * as requests from "../requests.js";
import type * as robots from "../robots.js";
import type * as scrape from "../scrape.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  ai: typeof ai;
  bounties: typeof bounties;
  discovery: typeof discovery;
  "lib/decide": typeof lib_decide;
  "lib/discovery": typeof lib_discovery;
  "lib/drafts": typeof lib_drafts;
  "lib/actorRows": typeof lib_actorRows;
  "lib/extract": typeof lib_extract;
  "lib/personas": typeof lib_personas;
  "lib/roi": typeof lib_roi;
  "lib/specs": typeof lib_specs;
  "lib/validation": typeof lib_validation;
  "lib/verify": typeof lib_verify;
  maintenance: typeof maintenance;
  requests: typeof requests;
  robots: typeof robots;
  scrape: typeof scrape;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
