// US sale status: can this robot be sold in the US today under the FCC's July 2026 robot rule?
// Pure code, no DB, no AI. The answer is only as good as the origin fields on the robot row; when
// they are missing it says "unknown" rather than guessing.
//
// Background (as of 2026-10-31):
// - An FCC action adopted July 28, 2026 added foreign-produced "advanced robotic devices" to the
//   Covered List: new models of mobile robots that operate at a distance from a human, weigh more
//   than 4.4 lb including the dock, and have sensors, >= 200 kbps connectivity and software that
//   controls navigation, perception or command-and-control (AMRs, humanoids, quadrupeds, mobile
//   manipulators, delivery robots, autonomous forklifts, robot vacuums).
// - "Foreign-produced" means it fails the Buy American domestic end product test: manufactured in
//   the US with more than 65% domestic component cost through 2028, 75% from 2029.
// - Exempt: fixed stationary industrial robots (articulated arms, delta, gantry, SCARA), UAS,
//   UUVs (underwater), connected vehicles, and certain medical/mobility devices.
// - Models authorized before the rule can keep being sold unmodified; new foreign models need FCC
//   "Conditional Approval".
// Sources:
//   https://www.fenwick.com/insights/publications/fcc-bans-new-foreign-produced-advanced-robotic-devices-and-power-inverters
//   https://interact-analysis.prezly.com/what-the-fcc-ruling-on-advanced-robotic-devices-means-for-the-us-mobile-robot-market
//   https://www.thefai.org/posts/did-the-fcc-just-ban-foreign-robots
//
// Rules, first match wins:
//   1. sample                                        -> unknown (fictional robot)
//   2. stationaryArm | underwater | mobile === false -> exempt
//   3. mobile && connected, and:
//      a. madeIn US, usContentShare >= 0.65          -> ok
//      b. authorizedBefore                           -> ok (existing model keeps selling)
//      c. madeIn US, usContentShare unknown          -> review (content share not verified)
//      d. madeIn US, usContentShare < 0.65           -> review (fails the domestic-content test)
//      e. madeIn set and not US                      -> review (needs conditional approval)
//   4. anything else                                 -> unknown
// The 65% threshold applies through 2028; it rises to 75% in 2029 and this file must change then.

export type UsSaleStatus = "ok" | "review" | "exempt" | "unknown";
export type UsSale = { status: UsSaleStatus; label: string; note: string };
export type UsSaleInput = {
  mobile?: boolean;
  connected?: boolean;
  stationaryArm?: boolean;
  underwater?: boolean;
  madeIn?: string; // ISO 3166-1 alpha-2, e.g. "US", "SE"
  usContentShare?: number; // 0..1, share of component cost that is domestic
  authorizedBefore?: boolean; // FCC equipment authorization predates 2026-07-28
  sample?: boolean;
};

export const RULE_DATE = "2026-07-28";
export const DOMESTIC_CONTENT_THRESHOLD = 0.65; // through 2028; 0.75 from 2029

const out = (status: UsSaleStatus, label: string, note: string): UsSale => ({ status, label, note });

export function usSaleStatus(i: UsSaleInput): UsSale {
  if (i.sample) return out("unknown", "Sample robot", "Sample robot: not a real product");
  if (i.stationaryArm || i.underwater || i.mobile === false) {
    return out("exempt", "Exempt", "Stationary or non-covered device; FCC mobile-robot rule does not apply");
  }
  if (i.mobile && i.connected) {
    const madeIn = i.madeIn?.trim().toUpperCase() || undefined;
    const share = typeof i.usContentShare === "number" && Number.isFinite(i.usContentShare) &&
      i.usContentShare >= 0 && i.usContentShare <= 1 ? i.usContentShare : undefined;
    if (madeIn === "US" && share !== undefined && share >= DOMESTIC_CONTENT_THRESHOLD) {
      return out("ok", "OK", "US-made, meets 65% domestic content");
    }
    if (i.authorizedBefore === true) {
      return out("ok", "OK", "Authorized before the July 2026 rule; existing model can still be sold");
    }
    if (madeIn === "US" && share === undefined) {
      return out("review", "FCC review", "US-made; domestic-content share not yet verified");
    }
    if (madeIn === "US") {
      return out("review", "FCC review", "US-made but below 65% domestic content: needs FCC conditional approval before US sale");
    }
    if (madeIn) {
      return out("review", "FCC review", "New foreign-made connected mobile robot: needs FCC conditional approval before US sale");
    }
  }
  return out("unknown", "Unknown", "Not enough information to assess US sale status");
}

// The same, straight from a robots-table row (its optional origin fields).
export function usSaleOfRobot(r: {
  sample?: boolean; mobile?: boolean; connected?: boolean; stationaryArm?: boolean; underwater?: boolean;
  madeIn?: string; usContentShare?: number; fccAuthorizedBefore?: boolean;
}): UsSale {
  return usSaleStatus({
    sample: r.sample, mobile: r.mobile, connected: r.connected, stationaryArm: r.stationaryArm,
    underwater: r.underwater, madeIn: r.madeIn, usContentShare: r.usContentShare,
    authorizedBefore: r.fccAuthorizedBefore,
  });
}
