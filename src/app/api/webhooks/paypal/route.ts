import { env } from "@/lib/env";
import { verifyPayPalWebhook } from "@/lib/paypal/webhook-verify";
import { handleWebhookEvent, type PayPalWebhookEvent } from "@/lib/paypal/webhook-handler";

/**
 * PayPal webhook endpoint.
 *   401 → signature invalid (PayPal will not retry a forged request usefully)
 *   500 → our processing failed; PayPal retries, and the handler is idempotent
 *   200 → processed or duplicate
 */
export async function POST(request: Request) {
  const webhookId = env().PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.error("[webhook] PAYPAL_WEBHOOK_ID is not set — refusing unverifiable events");
    return Response.json({ error: "webhook not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const verification = await verifyPayPalWebhook({ headers: request.headers, rawBody, webhookId });
  if (!verification.valid) {
    console.warn(`[webhook] rejected: ${verification.reason}`);
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const result = await handleWebhookEvent(event);
    console.info(`[webhook] ${event.event_type} ${event.id} → ${JSON.stringify(result)}`);
    return Response.json({ received: true, result });
  } catch (e) {
    console.error(`[webhook] processing failed for ${event.id}:`, e);
    return Response.json({ error: "processing failed" }, { status: 500 });
  }
}
