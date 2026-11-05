"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * PayPal JavaScript SDK v6 one-time checkout.
 * The browser only ever sends a product id; our server prices and creates the
 * order, and captures it after the buyer approves.
 */

type PayPalSession = { start: (opts: { presentationMode: string }, order: Promise<{ orderId: string }>) => Promise<void> };
type PayPalSdk = {
  createInstance: (opts: { clientId: string; components: string[]; pageType?: string }) => Promise<{
    findEligibleMethods: (opts?: { currencyCode?: string }) => Promise<{ isEligible: (m: string) => boolean }>;
    createPayPalOneTimePaymentSession: (callbacks: {
      onApprove: (data: { orderId: string }) => Promise<void>;
      onCancel?: () => void;
      onError?: (err: { code?: string; message?: string }) => void;
    }) => PayPalSession | Promise<PayPalSession>;
  }>;
};
declare global {
  interface Window {
    paypal?: PayPalSdk;
  }
}

let sdkPromise: Promise<PayPalSdk> | null = null;
function loadSdk(src: string): Promise<PayPalSdk> {
  sdkPromise ??= new Promise((resolve, reject) => {
    if (window.paypal) return resolve(window.paypal);
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal SDK missing")));
    s.onerror = () => {
      sdkPromise = null;
      reject(new Error("Could not load PayPal"));
    };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "paying" } | { kind: "error"; message: string } | { kind: "info"; message: string };

export function PayPalCheckout({
  productId,
  storeSlug,
  clientId,
  sdkUrl,
}: {
  productId: string;
  storeSlug: string;
  clientId: string;
  sdkUrl: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let button: HTMLElement | null = null;

    async function createOrder(): Promise<{ orderId: string }> {
      const res = await fetch("/api/checkout/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start checkout");
      return { orderId: body.orderId };
    }

    async function onApprove({ orderId }: { orderId: string }) {
      setStatus({ kind: "paying" });
      const res = await fetch(`/api/checkout/orders/${orderId}/capture`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setStatus({ kind: "error", message: body.error ?? "Payment could not be completed" });
        return;
      }
      router.push(`/s/${storeSlug}/order/${body.orderId}`);
    }

    (async () => {
      try {
        const paypal = await loadSdk(sdkUrl);
        const sdk = await paypal.createInstance({ clientId, components: ["paypal-payments"], pageType: "product-details" });
        const eligible = await sdk.findEligibleMethods({ currencyCode: "USD" });
        if (cancelled) return;
        if (!eligible.isEligible("paypal")) {
          setStatus({ kind: "error", message: "PayPal isn't available in your region." });
          return;
        }
        const session = await sdk.createPayPalOneTimePaymentSession({
          onApprove,
          onCancel: () => setStatus({ kind: "info", message: "Payment cancelled — you haven't been charged." }),
          onError: (err) => setStatus({ kind: "error", message: err.message ?? "PayPal had a problem. Please try again." }),
        });
        button = document.createElement("paypal-button");
        button.setAttribute("type", "pay");
        button.addEventListener("click", () => {
          setStatus({ kind: "ready" });
          // Don't await createOrder before start(): the popup needs the click's user activation.
          session.start({ presentationMode: "auto" }, createOrder()).catch((e: Error) =>
            setStatus({ kind: "error", message: e.message }),
          );
        });
        container.current?.appendChild(button);
        setStatus({ kind: "ready" });
      } catch (e) {
        if (!cancelled) setStatus({ kind: "error", message: (e as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      button?.remove();
    };
  }, [clientId, productId, router, sdkUrl, storeSlug]);

  return (
    <div className="space-y-2">
      <div ref={container} className="min-h-[48px]" />
      {status.kind === "loading" && <p className="text-sm text-muted">Loading PayPal…</p>}
      {status.kind === "paying" && <p className="text-sm text-muted">Completing your payment…</p>}
      {status.kind === "info" && <p className="text-sm text-muted">{status.message}</p>}
      {status.kind === "error" && (
        <p role="alert" className="border-l-2 border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
          {status.message}
        </p>
      )}
    </div>
  );
}
