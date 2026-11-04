import { paypal } from "@/lib/paypal/client";

/**
 * Publishing to the PayPal catalog is a deterministic step the seller triggers
 * with a tap — the AI drafts the listing, but never publishes on its own.
 */

export type CatalogProduct = { id: string; name: string; type: string; create_time?: string };

export async function createCatalogProduct(input: {
  name: string;
  description: string;
  imageUrl?: string;
  homeUrl?: string;
  requestId: string;
}): Promise<CatalogProduct> {
  const isPublicUrl = (u?: string) => !!u && u.startsWith("https://");
  return paypal<CatalogProduct>("/v1/catalogs/products", {
    method: "POST",
    requestId: input.requestId, // same draft → same PayPal product, even on retries
    body: {
      name: input.name.slice(0, 127),
      description: input.description.slice(0, 256),
      type: "PHYSICAL",
      // PayPal only accepts publicly reachable https URLs here.
      ...(isPublicUrl(input.imageUrl) ? { image_url: input.imageUrl } : {}),
      ...(isPublicUrl(input.homeUrl) ? { home_url: input.homeUrl } : {}),
    },
  });
}
