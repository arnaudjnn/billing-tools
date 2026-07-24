export async function callTool(config, tool, args = {}) {
    const res = await fetch(`${config.baseUrl}/api/v0/${tool}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(args),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${tool} failed (${res.status}): ${text}`);
    }
    return res.json();
}
export async function listTools(config) {
    const res = await fetch(`${config.baseUrl}/api/v0`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok)
        throw new Error(`Failed to list tools: ${res.status}`);
    const data = (await res.json());
    return data.tools;
}
//# sourceMappingURL=client.js.map