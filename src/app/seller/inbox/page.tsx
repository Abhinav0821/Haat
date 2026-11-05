import type { Metadata } from "next";
import { Inbox } from "./inbox";

export const metadata: Metadata = { title: "Messages · Haat" };

export default function Page() {
  return <Inbox />;
}
