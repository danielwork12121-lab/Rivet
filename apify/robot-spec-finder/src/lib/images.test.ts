import { describe, expect, it } from "vitest";
import { cleanImageUrl, pageImage, verifiedImage } from "./images";

describe("pageImage", () => {
  it("prefers the Product JSON-LD image, then og:image, resolving relative URLs", () => {
    expect(pageImage({
      url: "https://vendor.example/x1",
      metadata: { jsonLd: [{ "@type": "Organization" }, { "@graph": [{ "@type": "Product", image: ["/img/x1.jpg"] }] }],
        openGraph: [{ property: "og:image", content: "https://vendor.example/og.jpg" }] },
    })).toBe("https://vendor.example/img/x1.jpg");
    expect(pageImage({
      url: "https://vendor.example/x1",
      metadata: { openGraph: [{ property: "og:title", content: "X1" }, { property: "og:image", content: "/og.jpg" }] },
    })).toBe("https://vendor.example/og.jpg");
    expect(pageImage({ url: "https://vendor.example/x1", metadata: {} })).toBeNull();
  });

  it("skips logos, icons, svgs and non-http URLs", () => {
    expect(cleanImageUrl("https://v.example/assets/logo.png")).toBeNull();
    expect(cleanImageUrl("https://v.example/a.svg")).toBeNull();
    expect(cleanImageUrl("data:image/png;base64,AAA")).toBeNull();
    expect(cleanImageUrl("javascript:alert(1)")).toBeNull();
    expect(cleanImageUrl("https://v.example/robot.jpg")).toBe("https://v.example/robot.jpg");
  });
});

describe("verifiedImage", () => {
  const page = { url: "https://vendor.example/x1", markdown: "Meet X1 ![X1](/img/x1.jpg) today." };
  it("keeps an AI-picked image only if the page links it", () => {
    expect(verifiedImage("/img/x1.jpg", page)).toBe("https://vendor.example/img/x1.jpg");
    expect(verifiedImage("https://elsewhere.example/made-up.jpg", page)).toBeNull();
    expect(verifiedImage(null, page)).toBeNull();
  });
});
