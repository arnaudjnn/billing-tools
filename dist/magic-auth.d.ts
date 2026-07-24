import type { BillingUser } from "./types.js";
export declare function sendMagicAuth(email: string): Promise<void>;
export declare function verifyMagicAuth(email: string, code: string): Promise<BillingUser>;
//# sourceMappingURL=magic-auth.d.ts.map