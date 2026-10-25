// Product photos for robots, taken from the vendor's own page. Plain code: an image URL is
// kept only if the page itself names it (its og:image / twitter:image / Product JSON-LD, or a
// link in the page text), so the AI can't make one up. Same file in apify/robot-spec-finder/src/lib.

type Meta = {
  openGraph?: { property?: string; content?: string }[] | Record<string, unknown>;
  jsonLd?: unknown;
  [k: string]: unknown;
};
export type CrawledPage = { url?: string; markdown?: string; text?: string; metadata?: Meta; imageUrl?: string };

const NOT_A_PHOTO = /logo|favicon|icon|sprite|placeholder|avatar|badge|banner-ad|pixel|1x1|\.svg(\?|$)/i;

// An absolute http(s) URL that looks like a photo, or null.
export function cleanImageUrl(raw: unknown, base?: string): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.startsWith("data:")) return null;
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const href = url.toString();
  if (href.length > 1000 || NOT_A_PHOTO.test(url.pathname)) return null;
  return href;
}

function openGraphImage(og: Meta["openGraph"]): unknown {
  if (Array.isArray(og)) {
    const hit = og.find((p) => /^(og:image(:secure_url|:url)?|twitter:image)$/i.test(p?.property ?? ""));
    return hit?.content;
  }
  if (og && typeof og === "object") return og["og:image"] ?? og["image"] ?? og["twitter:image"];
  return undefined;
}

// The first Product image in JSON-LD (an object, an array, or an @graph).
function jsonLdImage(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== "object" || depth > 4) return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = jsonLdImage(n, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  const o = node as Record<string, unknown>;
  const type = String(o["@type"] ?? "");
  if (/Product/i.test(type) && o.image) {
    const img = Array.isArray(o.image) ? o.image[0] : o.image;
    return typeof img === "object" && img ? (img as Record<string, unknown>).url : img;
  }
  return jsonLdImage(o["@graph"], depth + 1);
}

// The page's main photo: Product JSON-LD first (it's about the product), then og:image.
export function pageImage(page: CrawledPage): string | null {
  const meta = page.metadata ?? {};
  for (const raw of [page.imageUrl, jsonLdImage(meta.jsonLd), openGraphImage(meta.openGraph), meta["og:image"]]) {
    const url = cleanImageUrl(raw, page.url);
    if (url) return url;
  }
  return null;
}

// A photo the AI picked for one robot, kept only if that URL is linked in the page text.
export function verifiedImage(raw: string | null | undefined, page: { url: string; markdown: string }): string | null {
  if (!raw) return null;
  const url = cleanImageUrl(raw, page.url);
  if (!url) return null;
  return page.markdown.includes(raw.trim()) || page.markdown.includes(url) ? url : null;
}
