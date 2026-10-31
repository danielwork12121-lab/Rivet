import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Ends searches, matches and breakdowns that crashed or ran out of time (sweep.ts).
crons.interval("sweep stuck agent work", { minutes: 5 }, internal.sweep.sweepStuck, {});

export default crons;
