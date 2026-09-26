// DEV ONLY - /dev/film: the x-ray film + exposure transition on synthetic data (makeSyntheticScan).
// Not linked from the app, not indexed, and a 404 in production builds.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DevFilmBench from "@/components/exposure/film/DevFilmBench";

export const metadata: Metadata = {
  title: "Film bench (dev)",
  robots: { index: false, follow: false },
};

export default function DevFilmPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DevFilmBench />;
}
