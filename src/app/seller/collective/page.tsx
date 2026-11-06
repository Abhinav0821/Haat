import type { Metadata } from "next";
import { Suspense } from "react";
import { Collective } from "./collective";

export const metadata: Metadata = { title: "Collective orders · Haat" };

export default function Page() {
  return (
    <Suspense>
      <Collective />
    </Suspense>
  );
}
