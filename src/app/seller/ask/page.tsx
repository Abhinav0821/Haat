import type { Metadata } from "next";
import { Ask } from "./ask";

export const metadata: Metadata = { title: "Ask Haat · Haat" };

export default function Page() {
  return <Ask />;
}
