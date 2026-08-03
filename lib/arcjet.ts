import arcjet, {
  tokenBucket,
  detectPromptInjection,
  sensitiveInfo,
} from "@arcjet/next";

// Route-level Arcjet client for /api/gen-ai-code only.
// shield + detectBot handled globally in proxy.ts,
// Characteristics: "userId" means each Clerk user gets their own token bucket,
// so corporate offices / VPNs sharing an IP don't share rate limits.

const arcjetKey = (process.env.ARCJET_KEY ?? "").trim();

export const aj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      characteristics: ["userId"],
      rules: [
        tokenBucket({
          mode: "LIVE",
          refillRate: 5,
          interval: 60,
          capacity: 5,
        }),
        detectPromptInjection({
          mode: "LIVE",
        }),
      ],
    })
  : ({
      protect: async () => ({
        isDenied: () => false,
        reason: { isRateLimit: () => false, isPromptInjection: () => false },
      }),
    } as any);
