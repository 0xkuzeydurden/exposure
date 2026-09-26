import type { Metadata, Viewport } from "next";
import { Courier_Prime, IBM_Plex_Sans_Condensed, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/** Signage and labels. */
const plex = IBM_Plex_Sans_Condensed({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

/** The typed radiology report. */
const courier = Courier_Prime({
  variable: "--font-courier",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

/** The film and data (the film's CSS module reads --font-jetbrains). */
const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const TAGLINE = "Every chart shows you the price. EXPOSURE shows who's behind it.";
const DESCRIPTION = `${TAGLINE} Paste a token and EXPOSURE takes an x-ray: who really bought it, who is selling to whom, where sellers are waiting and whether smart money is in profit. Powered by Nansen API.`;

/** Absolute base for Open Graph URLs: SITE_URL, else the Vercel deployment URL, else localhost. */
function siteUrl(): URL {
  const explicit = process.env.SITE_URL?.trim();
  if (explicit) {
    try {
      return new URL(explicit);
    } catch {
      /* fall through */
    }
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return new URL(vercel ? `https://${vercel}` : "http://localhost:3000");
}

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: {
    default: "EXPOSURE · an x-ray for any token",
    template: "%s · EXPOSURE",
  },
  description: DESCRIPTION,
  applicationName: "EXPOSURE",
  openGraph: {
    title: "EXPOSURE · an x-ray for any token",
    description: TAGLINE,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "EXPOSURE · an x-ray for any token",
    description: TAGLINE,
  },
};

export const viewport: Viewport = {
  themeColor: "#05080b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plex.variable} ${courier.variable} ${jetbrains.variable}`}>
      <body>
        {children}
        <footer>
          <a className="attribution" href="https://www.nansen.ai" target="_blank" rel="noopener noreferrer">
            Powered by Nansen API
          </a>
        </footer>
      </body>
    </html>
  );
}
