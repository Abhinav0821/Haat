import type { Metadata } from "next";
import { Products } from "./products";

export const metadata: Metadata = { title: "My pieces · Haat" };

export default function Page() {
  return <Products />;
}
