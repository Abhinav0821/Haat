import type { Metadata } from "next";
import { Rules } from "./rules";

export const metadata: Metadata = { title: "My rules · Haat" };

export default function Page() {
  return <Rules />;
}
