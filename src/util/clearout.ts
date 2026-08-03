// Best-effort company enrichment from a domain (name + logo).
//
// **Opt-in.** Pass it to the adapter explicitly — `new WorkOSOrgAdapter({
// enrichOrg: lookupCompany })` — because it sends the domain to a third party
// (api.clearout.io). It used to be wired in unconditionally, so every deployment
// using that adapter forwarded its customers' email domains to an unrelated
// service with no env var to notice it by and no way to turn it off. Naming the
// call at the call site is the whole fix.
//
// Never throws AND never hangs: it sits on the path that creates a workspace, so a
// third party having a bad day must cost a nicer org name, not the signup. "Never
// throws" alone did not cover that — an unbounded `fetch` fails by not returning.
const TIMEOUT_MS = 3_000;

export async function lookupCompany(
  domain: string,
): Promise<{ name: string; logoUrl: string } | null> {
  try {
    const res = await fetch(
      `https://api.clearout.io/public/companies/autocomplete?query=${encodeURIComponent(domain)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ name: string; domain: string; logo_url: string }>;
    };
    const match = data.data?.find((c) => c.domain.toLowerCase() === domain.toLowerCase());
    if (!match) return null;
    return { name: match.name, logoUrl: match.logo_url };
  } catch {
    // Includes the timeout: an AbortError lands here like any other failure.
    return null;
  }
}
