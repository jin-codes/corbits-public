/**
 * Asks Anthropic whether a key works, before it is saved, by listing models (a read that makes no model
 * call). "invalid" only when Anthropic says the key is wrong (401/403); if Anthropic cannot be reached the answer
 * is "unknown", so an outage does not stop someone from saving a key. Docs: https://platform.claude.com/docs/en/api/models/list
 */
export type KeyCheck = "valid" | "invalid" | "unknown";

export async function checkAnthropicKey(apiKey: string, doFetch: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const res = await doFetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) return "valid";
    return res.status === 401 || res.status === 403 ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}
