import { describe, expect, it } from "vitest";
import { usSaleOfRobot, usSaleStatus } from "./usSale";

const mobileConnected = { mobile: true, connected: true };

describe("usSaleStatus", () => {
  it("sample robots are unknown, whatever else they say", () => {
    const s = usSaleStatus({ sample: true, ...mobileConnected, madeIn: "US", usContentShare: 1 });
    expect(s).toEqual({ status: "unknown", label: "Sample robot", note: "Sample robot: not a real product" });
  });

  it.each([
    [{ stationaryArm: true, connected: true, madeIn: "CN" }],
    [{ underwater: true, mobile: true, connected: true, madeIn: "CN" }],
    [{ mobile: false, connected: true, madeIn: "CN" }],
  ])("stationary arms, underwater and non-mobile devices are exempt: %o", (input) => {
    const s = usSaleStatus(input);
    expect(s.status).toBe("exempt");
    expect(s.note).toBe("Stationary or non-covered device; FCC mobile-robot rule does not apply");
  });

  it("US-made at or above 65% domestic content is ok", () => {
    for (const share of [0.65, 0.9, 1]) {
      const s = usSaleStatus({ ...mobileConnected, madeIn: "US", usContentShare: share });
      expect(s.status).toBe("ok");
      expect(s.note).toBe("US-made, meets 65% domestic content");
    }
  });

  it("a model authorized before the rule is ok even if foreign-made", () => {
    const s = usSaleStatus({ ...mobileConnected, madeIn: "SE", authorizedBefore: true });
    expect(s.status).toBe("ok");
    expect(s.note).toBe("Authorized before the July 2026 rule; existing model can still be sold");
  });

  it("a pre-rule authorization covers a US-made robot with unverified content share", () => {
    expect(usSaleStatus({ ...mobileConnected, madeIn: "US", authorizedBefore: true }).status).toBe("ok");
  });

  it("US-made with unknown content share and no prior authorization needs review", () => {
    for (const usContentShare of [undefined, NaN, -1, 2]) {
      const s = usSaleStatus({ ...mobileConnected, madeIn: "US", usContentShare, authorizedBefore: false });
      expect(s.status).toBe("review");
      expect(s.note).toBe("US-made; domestic-content share not yet verified");
    }
  });

  it("US-made below 65% domestic content needs review", () => {
    const s = usSaleStatus({ ...mobileConnected, madeIn: "us", usContentShare: 0.64 });
    expect(s.status).toBe("review");
    expect(s.note).toMatch(/below 65% domestic content/);
  });

  it("a new foreign-made connected mobile robot needs FCC conditional approval", () => {
    const s = usSaleStatus({ ...mobileConnected, madeIn: "CN", authorizedBefore: false });
    expect(s).toEqual({
      status: "review",
      label: "FCC review",
      note: "New foreign-made connected mobile robot: needs FCC conditional approval before US sale",
    });
  });

  it.each([
    [{}],
    [{ mobile: true, connected: true }],
    [{ mobile: true, madeIn: "CN" }],
    [{ connected: true, madeIn: "CN" }],
    [{ mobile: true, connected: true, madeIn: "  " }],
  ])("anything else is unknown: %o", (input) => {
    const s = usSaleStatus(input);
    expect(s.status).toBe("unknown");
    expect(s.note).toBe("Not enough information to assess US sale status");
  });
});

describe("usSaleOfRobot", () => {
  it("reads fccAuthorizedBefore from a robot row", () => {
    expect(usSaleOfRobot({ sample: false, mobile: true, connected: true, madeIn: "SE", fccAuthorizedBefore: true }).status).toBe("ok");
    expect(usSaleOfRobot({ sample: false, mobile: true, connected: true, madeIn: "US", fccAuthorizedBefore: false }).status).toBe("review");
    expect(usSaleOfRobot({ sample: false }).status).toBe("unknown");
  });
});
