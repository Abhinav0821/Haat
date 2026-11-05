import { AgreementError } from "./agreement";
import { CheckoutError } from "@/lib/paypal/orders";

/** Known refusals become readable 4xx answers; anything else is logged as a 5xx. */
export function errorResponse(e: unknown, where: string): Response {
  if (e instanceof AgreementError || e instanceof CheckoutError) return Response.json({ error: e.message }, { status: e.status });
  console.error(`[${where}] failed:`, e);
  return Response.json({ error: "Something went wrong — please try again in a minute." }, { status: 503 });
}
