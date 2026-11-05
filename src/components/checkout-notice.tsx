"use client";

import { useSearchParams } from "next/navigation";

/** Shown on the home page if returning from a PayPal approval didn't complete. */
export function CheckoutNotice() {
  const params = useSearchParams();
  if (params.get("checkout") !== "failed") return null;
  return (
    <p role="alert" className="mx-auto mt-6 max-w-xl border-l-2 border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
      We couldn’t complete that PayPal payment, and you haven’t been charged. Please try again from the product page.
    </p>
  );
}
