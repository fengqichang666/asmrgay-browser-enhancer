import { describe, expect, it } from "vitest";

import { normalizeUrl } from "../../src/core/url.js";

describe("normalizeUrl", () => {
  it("resolves relative URLs against the source page", () => {
    expect(normalizeUrl("../作品", "https://www.asmrgay.com/asmr/中文音声/"))
      .toBe("https://www.asmrgay.com/asmr/%E4%BD%9C%E5%93%81");
  });

  it("lowercases the host while preserving path case", () => {
    expect(normalizeUrl("https://WWW.ASMRGAY.COM/ASMR/MixCase"))
      .toBe("https://www.asmrgay.com/ASMR/MixCase");
  });

  it("removes fragments", () => {
    expect(normalizeUrl("https://www.asmrgay.com/asmr?page=2#player"))
      .toBe("https://www.asmrgay.com/asmr?page=2");
  });

  it("removes known tracking parameters but retains functional parameters", () => {
    expect(normalizeUrl(
      "https://www.asmrgay.com/asmr?page=2&utm_source=test&fbclid=abc",
    )).toBe("https://www.asmrgay.com/asmr?page=2");
  });

  it("supports additional site-specific tracking parameters", () => {
    expect(normalizeUrl(
      "https://www.asmrgay.com/asmr?page=2&ref=promo",
      undefined,
      { trackingParameters: new Set(["ref"]) },
    )).toBe("https://www.asmrgay.com/asmr?page=2");
  });

  it("sorts retained query parameters by key and value", () => {
    expect(normalizeUrl("https://www.asmrgay.com/asmr?tag=z&page=2&tag=a"))
      .toBe("https://www.asmrgay.com/asmr?page=2&tag=a&tag=z");
  });

  it("normalizes percent escapes without decoding reserved separators", () => {
    expect(normalizeUrl("https://www.asmrgay.com/%7euser/a%2fb?q=%7e%2f"))
      .toBe("https://www.asmrgay.com/~user/a%2Fb?q=~%2F");
  });

  it("normalizes the root path to a slash", () => {
    expect(normalizeUrl("https://www.asmrgay.com"))
      .toBe("https://www.asmrgay.com/");
  });

  it("preserves whether a non-root path has a trailing slash", () => {
    expect(normalizeUrl("https://www.asmrgay.com/asmr/"))
      .toBe("https://www.asmrgay.com/asmr/");
    expect(normalizeUrl("https://www.asmrgay.com/asmr"))
      .toBe("https://www.asmrgay.com/asmr");
  });

  it("upgrades HTTP only for explicitly verified hosts", () => {
    const options = { httpsUpgradeHosts: new Set(["www.asmrgay.com"]) };

    expect(normalizeUrl("http://www.asmrgay.com/asmr", undefined, options))
      .toBe("https://www.asmrgay.com/asmr");
    expect(normalizeUrl("http://example.com/asmr", undefined, options))
      .toBe("http://example.com/asmr");
  });

  it("keeps www and bare hosts distinct", () => {
    expect(normalizeUrl("https://www.asmrgay.com/"))
      .not.toBe(normalizeUrl("https://asmrgay.com/"));
  });

  it("rejects non-HTTP protocols", () => {
    expect(() => normalizeUrl("javascript:alert(1)"))
      .toThrow("Unsupported URL protocol");
  });
});
