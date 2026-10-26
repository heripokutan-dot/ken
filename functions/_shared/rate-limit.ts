// Adapter over a Cloudflare rate-limiting binding (expected shape: `limit({ key }) -> { success }`).
// Fails closed: if no binding is configured the token endpoint refuses to issue tokens.

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type RateLimitResult = "ok" | "limited" | "unavailable";

export async function checkRateLimit(binding: RateLimiterBinding | undefined, key: string): Promise<RateLimitResult> {
  if (!binding || typeof binding.limit !== "function") return "unavailable";
  try {
    const { success } = await binding.limit({ key });
    return success ? "ok" : "limited";
  } catch {
    return "unavailable";
  }
}
