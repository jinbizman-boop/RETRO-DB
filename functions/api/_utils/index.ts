// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\index.ts

/**
 * Barrel module for API utilities.
 * - Keeps original contract EXACTLY:
 *   export * from "./db";
 *   export * from "./json";
 *   export * from "./cors";
 *   export * from "./auth";
 *   export * as Rate from "./rate-limit";
 *
 * Enhancements:
 * - Explicit type re-exports for better DX and IntelliSense
 * - Side-effect free barrel (tree-shaking friendly)
 */

// Re-export runtime utilities (UNCHANGED public API)
export * from "./db";
export * from "./json";
export * from "./cors";
export * from "./auth";
export * as Rate from "./rate-limit";

// Optional: explicit type re-exports (non-breaking, improves autocomplete)
export type { Env } from "./db";
export type { JwtPayload } from "./auth";
