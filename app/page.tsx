import { Room } from "@/components/exposure/Room";
import { parseDirectorParams } from "@/components/exposure/DirectorScript";
import { loadFeaturedScan } from "@/lib/xray/store";

// The featured patient is read from disk on every request, so a freshly warmed gallery shows up
// without a rebuild.
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Home: the featured patient (first waiting-room scan, else the synthetic preview), exposed once.
 * `?rec=1` (or `?director=1`) plays the recording-mode demo script instead (`&speed=2`, `&autostart=1`).
 */
export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const [scan, query] = await Promise.all([loadFeaturedScan().catch(() => null), searchParams]);
  const director = parseDirectorParams(query, process.env.NEXT_PUBLIC_REPO_URL);
  return <Room initial={{ kind: "featured", scan }} director={director} />;
}
