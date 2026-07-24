// Best-effort company enrichment from a domain (name + logo), used by the
// WorkOS-org adapter when creating an org. Never throws.
export async function lookupCompany(
  domain: string,
): Promise<{ name: string; logoUrl: string } | null> {
  try {
    const res = await fetch(
      `https://api.clearout.io/public/companies/autocomplete?query=${encodeURIComponent(domain)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ name: string; domain: string; logo_url: string }>;
    };
    const match = data.data?.find((c) => c.domain.toLowerCase() === domain.toLowerCase());
    if (!match) return null;
    return { name: match.name, logoUrl: match.logo_url };
  } catch {
    return null;
  }
}
