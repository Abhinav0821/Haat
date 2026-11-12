import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Geist, Geist_Mono, Noto_Sans_Devanagari } from "next/font/google";
import { THEME_SCRIPT } from "@/lib/client/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});
const devanagari = Noto_Sans_Devanagari({
  variable: "--font-devanagari",
  subsets: ["devanagari"],
  weight: ["300", "400", "500"],
});

export const metadata: Metadata = {
  title: "Haat",
  description: "Sell to the world by voice, in your own language. Paid with PayPal.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f3ee",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${devanagari.variable} ${cormorant.variable} h-full antialiased`}
    >
      <head>
        <script id="haat-theme" dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
