import { env } from "@/lib/env";
import type { Comparable } from "./fair-price";

/**
 * Channel3 product search (https://channel3.ai/docs) — live prices of similar
 * products across 100M+ items. One call = 1 credit. Fails soft: no key or an
 * error simply means no price advice.
 */

type C3Product = {
  title: string;
  images?: { url: string; cleaned_url?: string | null; is_main_image?: boolean }[];
  offers?: { url: string; domain: string; availability?: string; price?: { price: number; currency: string } }[];
};

export async function searchComparables(query: string): Promise<Comparable[] | null> {
  const key = env().CHANNEL3_API_KEY;
  if (!key || !query.trim()) return null;
  try {
    const res = await fetch("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query.slice(0, 200),
        limit: 30,
        filters: { availability: ["InStock"], conditions: ["new"] },
        config: { country: "US", currency: "USD", mode: "default" },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`[channel3] ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { products: C3Product[] };
    return data.products.flatMap((p) => {
      const offer = p.offers?.find((o) => o.price?.currency === "USD" && o.price.price > 0);
      if (!offer?.price) return [];
      const img = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];
      return [
        {
          title: p.title,
          priceCents: Math.round(offer.price.price * 100),
          domain: offer.domain,
          url: offer.url,
          image: img ? (img.cleaned_url ?? img.url) : null,
        },
      ];
    });
  } catch (e) {
    console.warn("[channel3] search failed:", (e as Error).message);
    return null;
  }
}
