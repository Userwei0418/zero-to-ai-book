declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    PUBLIC_ORIGIN?: string;
    BUCKET?: R2Bucket;
    TOKENPLAN_API_KEY?: string;
    TOKENPLAN_BASE_URL?: string;
    TOKENPLAN_MODEL?: string;
    AI_DAILY_LIMIT?: string;
    SELF_HOSTED_SANDBOX?: string;
    SANDBOX_API_URL?: string;
    SANDBOX_API_KEY?: string;
    GPU_API_URL?: string;
    GPU_API_KEY?: string;
  }
}
