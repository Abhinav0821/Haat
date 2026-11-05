import type { Metadata } from "next";
import { Suspense } from "react";
import { CustomRequests } from "./custom";

export const metadata: Metadata = { title: "Custom requests · Haat" };

export default function Page() {
  return (
    <Suspense>
      <CustomRequests />
    </Suspense>
  );
}
