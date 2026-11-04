import type { Metadata } from "next";
import { SpeakToList } from "./speak-to-list";

export const metadata: Metadata = { title: "Add a product · Haat" };

export default function Page() {
  return <SpeakToList />;
}
