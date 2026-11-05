import type { Metadata } from "next";
import { Suspense } from "react";
import { PinPad } from "./pin-pad";

export const metadata: Metadata = { title: "Sign in · Haat" };

export default function Page() {
  return (
    <Suspense>
      <PinPad />
    </Suspense>
  );
}
