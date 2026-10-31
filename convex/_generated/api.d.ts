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
import type * as aiBudget from "../aiBudget.js";
import type * as bounties from "../bounties.js";
import type * as crons from "../crons.js";
import type * as discovery from "../discovery.js";
import type * as lib_actorRows from "../lib/actorRows.js";
import type * as lib_aiBudget from "../lib/aiBudget.js";
import type * as lib_apify from "../lib/apify.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_decide from "../lib/decide.js";
import type * as lib_discovery from "../lib/discovery.js";
import type * as lib_drafts from "../lib/drafts.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_extract from "../lib/extract.js";
import type * as lib_images from "../lib/images.js";
import type * as lib_personas from "../lib/personas.js";
import type * as lib_pool from "../lib/pool.js";
import type * as lib_roi from "../lib/roi.js";
import type * as lib_score from "../lib/score.js";
import type * as lib_specs from "../lib/specs.js";
import type * as lib_usSale from "../lib/usSale.js";
import type * as lib_validation from "../lib/validation.js";
import type * as lib_verify from "../lib/verify.js";
import type * as lib_workflow from "../lib/workflow.js";
import type * as maintenance from "../maintenance.js";
import type * as matching from "../matching.js";
import type * as requests from "../requests.js";
import type * as robots from "../robots.js";
import type * as scrape from "../scrape.js";
import type * as sweep from "../sweep.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  ai: typeof ai;
  aiBudget: typeof aiBudget;
  bounties: typeof bounties;
  crons: typeof crons;
  discovery: typeof discovery;
  "lib/actorRows": typeof lib_actorRows;
  "lib/aiBudget": typeof lib_aiBudget;
  "lib/apify": typeof lib_apify;
  "lib/auth": typeof lib_auth;
  "lib/decide": typeof lib_decide;
  "lib/discovery": typeof lib_discovery;
  "lib/drafts": typeof lib_drafts;
  "lib/env": typeof lib_env;
  "lib/extract": typeof lib_extract;
  "lib/images": typeof lib_images;
  "lib/personas": typeof lib_personas;
  "lib/pool": typeof lib_pool;
  "lib/roi": typeof lib_roi;
  "lib/score": typeof lib_score;
  "lib/specs": typeof lib_specs;
  "lib/usSale": typeof lib_usSale;
  "lib/validation": typeof lib_validation;
  "lib/verify": typeof lib_verify;
  "lib/workflow": typeof lib_workflow;
  maintenance: typeof maintenance;
  matching: typeof matching;
  requests: typeof requests;
  robots: typeof robots;
  scrape: typeof scrape;
  sweep: typeof sweep;
  users: typeof users;
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
