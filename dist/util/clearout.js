// Best-effort company enrichment from a domain (name + logo), used by the
// WorkOS-org adapter when creating an org. Never throws.
export async function lookupCompany(domain) {
    try {
        const res = await fetch(`https://api.clearout.io/public/companies/autocomplete?query=${encodeURIComponent(domain)}`);
        if (!res.ok)
            return null;
        const data = (await res.json());
        const match = data.data?.find((c) => c.domain.toLowerCase() === domain.toLowerCase());
        if (!match)
            return null;
        return { name: match.name, logoUrl: match.logo_url };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=clearout.js.map