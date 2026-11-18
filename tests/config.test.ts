import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("has sane defaults and reads env overrides", () => {
    const d = loadConfig({});
    expect(d.AIPM_PORT).toBe(4317);
    expect(d.AIPM_DEFAULT_PROFILE).toBe("balanced");
    expect(d.timeouts.worker).toBe(45 * 60_000);
    expect(loadConfig({ AIPM_PORT: "5000", AIPM_DEFAULT_PROFILE: "cost" })).toMatchObject({ AIPM_PORT: 5000, AIPM_DEFAULT_PROFILE: "cost" });
    expect(() => loadConfig({ AIPM_DEFAULT_PROFILE: "turbo" })).toThrow();
  });
});
