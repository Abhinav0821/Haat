import { generateText, Output } from "ai";
import { z } from "zod";
import { model } from "@/lib/ai/model";

/**
 * Spoken tracking numbers → validated PayPal tracking.
 * The model only transcribes; format checks and the carrier mapping are code.
 */

export const CARRIERS = {
  india_post: { label: "India Post", labelHi: "इंडिया पोस्ट", paypal: "INDIA_POST", pattern: /^[A-Z]{2}\d{9}IN$/ },
  bluedart: { label: "Blue Dart", labelHi: "ब्लू डार्ट", paypal: "BLUEDART", pattern: /^\d{8,11}$/ },
  dtdc: { label: "DTDC", labelHi: "डीटीडीसी", paypal: "DTDC", pattern: /^[A-Z]?\d{8,12}$/ },
  delhivery: { label: "Delhivery", labelHi: "डेल्हीवरी", paypal: "DELHIVERY", pattern: /^\d{10,14}$/ },
  dhl: { label: "DHL", labelHi: "डीएचएल", paypal: "DHL", pattern: /^\d{10}$/ },
  fedex: { label: "FedEx", labelHi: "फ़ेडएक्स", paypal: "FEDEX", pattern: /^\d{12}(\d{3})?$/ },
  ups: { label: "UPS", labelHi: "यूपीएस", paypal: "UPS", pattern: /^1Z[A-Z0-9]{16}$/ },
  other: { label: "Other courier", labelHi: "अन्य कूरियर", paypal: "OTHER", pattern: /^[A-Z0-9]{6,30}$/ },
} as const;
// NOTE: PayPal's sandbox accepts any carrier string. Verify these codes against
// PayPal's published carrier list before production; unknown couriers use OTHER.

export type CarrierKey = keyof typeof CARRIERS;

const HeardSchema = z.object({
  carrier: z.enum(Object.keys(CARRIERS) as [CarrierKey, ...CarrierKey[]]),
  trackingNumber: z.string().describe("Exactly the letters and digits spoken, no spaces. Hindi number words converted to digits."),
});

export function normalizeTracking(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function validateTracking(carrier: CarrierKey, trackingNumber: string) {
  const tn = normalizeTracking(trackingNumber);
  return { trackingNumber: tn, valid: CARRIERS[carrier].pattern.test(tn) };
}

/** "EE123456789IN" → "E E, 1 2 3, 4 5 6, 7 8 9, I N" — easy to check by ear. */
export function spellOut(tn: string): string {
  return tn.match(/[A-Z]+|\d{1,3}/g)?.map((g) => g.split("").join(" ")).join(", ") ?? tn;
}

export async function heardTracking(input: { text?: string; audio?: { data: Uint8Array; mediaType: string } }) {
  const { output } = await generateText({
    model: model(),
    system:
      "An Indian seller is reading out a courier name and tracking number, possibly in Hindi. Extract them exactly. Never invent characters; if unsure of the courier, use 'other'.",
    messages: [
      {
        role: "user",
        content: [
          ...(input.audio ? [{ type: "file" as const, data: input.audio.data, mediaType: input.audio.mediaType }] : []),
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
        ],
      },
    ],
    output: Output.object({ schema: HeardSchema, name: "tracking" }),
  });
  if (!output) throw new Error("could not understand the tracking number");
  const { trackingNumber, valid } = validateTracking(output.carrier, output.trackingNumber);
  const c = CARRIERS[output.carrier];
  return {
    carrier: output.carrier,
    carrierLabel: c.label,
    trackingNumber,
    valid,
    readBackHi: `${c.labelHi}, ट्रैकिंग नंबर ${spellOut(trackingNumber)}। क्या यह सही है?`,
  };
}

/**
 * Seller-confirmed tracking → PayPal (Agent Toolkit `create_shipment_tracking`).
 * Adding valid tracking strengthens Seller Protection and can release held funds sooner.
 */
export async function addTrackingToOrder(orderId: string, carrier: CarrierKey, rawTrackingNumber: string) {
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { runPayPalTool } = await import("@/lib/paypal/agent-tools");

  const { trackingNumber, valid } = validateTracking(carrier, rawTrackingNumber);
  if (!valid) throw new Error(`That doesn't look like a ${CARRIERS[carrier].label} tracking number`);

  const d = await db();
  const [order] = await d.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  if (!order?.paypalCaptureId) throw new Error("order is not paid yet");
  if (order.trackingNumber) return order; // already added — idempotent

  await runPayPalTool("create_shipment_tracking", {
    transaction_id: order.paypalCaptureId,
    order_id: order.paypalOrderId,
    tracking_number: trackingNumber,
    carrier: CARRIERS[carrier].paypal,
    status: "SHIPPED",
  });

  const [updated] = await d
    .update(schema.orders)
    .set({ trackingNumber, trackingCarrier: CARRIERS[carrier].label, trackingAddedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.orders.id, orderId))
    .returning();

  await d.insert(schema.messages).values({
    storeId: order.storeId,
    orderId: order.id,
    productId: order.items[0]?.productId ?? null,
    direction: "seller_to_buyer",
    channel: "autopilot",
    originalText: `आपका ऑर्डर ${CARRIERS[carrier].labelHi} से भेज दिया गया है। ट्रैकिंग नंबर ${trackingNumber}।`,
    originalLanguage: "Hindi",
    translatedText: `Your order is on its way with ${CARRIERS[carrier].label}. Tracking number: ${trackingNumber}.`,
    translatedLanguage: "English",
  });
  return updated;
}
