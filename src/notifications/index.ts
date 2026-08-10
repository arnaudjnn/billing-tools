import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Telling somebody. The half of billing this library could not do.
//
// It knows the moment a member is invited, the moment somebody asks their admin for more
// credit, the moment an allowance crosses 80%, and the moment a quote is answered. Every
// one of those is worth an email, and every one of them was silent — not because nobody
// wanted to send it, but because the library cannot render one. A branded email is JSX in
// the consumer's app, in the consumer's language, and this package compiles no `.tsx`,
// speaks no Italian and ships no template.
//
// So it does not send. It SAYS, on a channel the consumer chooses, and the consumer sends.
//
// ── The contract ─────────────────────────────────────────────────────────────
//
// Emitting never throws and never blocks. A notification describes something that already
// happened — the invitation exists, the credit was granted, the call was metered — so a
// delivery that fails must not undo it or delay it. Every call site fires and forgets, the
// way `metering.ts` already fires auto-reload, and a `deliver` that rejects is swallowed.
// (`usage-faults.ts` states the same rule for the same reason.)
//
// ── Why the LIBRARY resolves the recipients ──────────────────────────────────
//
// "Email the admins" is a question about membership and roles, which is this package's, and
// answering it in a consumer means answering it once per consumer. The event names the
// addresses; the app renders and sends to them.
//
// ── Idempotency ──────────────────────────────────────────────────────────────
//
// Every event carries a STABLE id derived from what it is about (`invite:<invitationId>`,
// `alert:<org>:<cycle>:<window>:<threshold>`), never a timestamp or a random. A retried
// webhook, a re-delivered event, a double-fire from two replicas: the consumer dedupes on
// that id and sends once. An id that changed per attempt would make dedupe impossible and
// the field a lie.

/** Which allowance an alert is about, in the consumer's own words where the plan gave any. */
export interface NotifiedWindow {
  every: string;
  label: string | null;
  used: number;
  limit: number;
  percent: number;
}

export interface NotifiedMember {
  id: string;
  email: string | null;
}

/** What happened. One variant per thing worth telling somebody about. */
export type BillingNotification =
  /** A member was invited and the invitation record exists. `to` is the invitee. */
  | {
      type: "invitation.created";
      orgId: string;
      to: string[];
      data: {
        invitationId: string;
        email: string;
        roleSlug: string;
        acceptUrl: string;
        organizationId: string;
        inviterUserId?: string;
      };
    }
  /** Somebody asked for more than their allowance. `to` is every admin of the workspace. */
  | {
      type: "topup.requested";
      orgId: string;
      to: string[];
      data: {
        requestId: string;
        member: NotifiedMember;
        credits: number;
        /** The window that refused them, when the ask came from one. */
        window: NotifiedWindow | null;
      };
    }
  /** An admin answered — or granted unprompted. `to` is the member it is about. */
  | {
      type: "topup.resolved";
      orgId: string;
      to: string[];
      data: {
        requestId: string | null;
        member: NotifiedMember;
        credits: number;
        outcome: "approved" | "denied" | "granted";
      };
    }
  /** Somebody asked to move up a rung the money cannot buy (a seat, a plan). */
  | {
      type: "upgrade.requested";
      orgId: string;
      to: string[];
      data: {
        requestId: string;
        member: NotifiedMember;
        kind: "seat" | "plan";
        /** The seat type or plan key they asked for. */
        target: string;
      };
    }
  /** An operator answered. `to` is the admin who asked. */
  | {
      type: "quote.resolved";
      orgId: string;
      to: string[];
      data: { quoteId: string; member: NotifiedMember; quote: unknown };
    }
  /** An allowance crossed a threshold. Fired once per window per threshold per cycle. */
  | {
      type: "usage.threshold";
      orgId: string;
      to: string[];
      data: {
        /** Whose wall it is: one member's pack, or the workspace's own pool/ceiling. */
        scope: "member" | "org";
        member: NotifiedMember | null;
        window: NotifiedWindow;
        /**
         * The threshold crossed, not the exact percentage.
         *
         * `percent` when it is a share of an allowance the plan gives (80, 100). `credits`
         * when it is the customer's OWN monthly spend alert, where they chose an absolute
         * figure and a percentage of it would be a number they never typed.
         */
        threshold: number;
        unit: "percent" | "credits";
      };
    };

/** An event as a consumer receives it: what happened, plus how to not send it twice. */
export type DeliverableNotification = BillingNotification & {
  /** Stable across retries and re-fires. Dedupe on this. */
  id: string;
  /** Epoch ms the event was emitted. */
  at: number;
};

export interface Notifier {
  deliver(notification: DeliverableNotification): Promise<void>;
}

/**
 * Who the event is for, stated as a question rather than an answer.
 *
 * A call site knows the workspace and, at most, a member id. Turning that into addresses is
 * a membership question, answered once in `createEmitter` — off the hot path, because a
 * metered call must not wait on a WorkOS round trip to send an email.
 */
export type Audience =
  /** Every admin of the workspace. "Somebody is asking you for something." */
  | { kind: "admins" }
  /** One member, by id. "Here is the answer to what you asked." */
  | { kind: "member"; memberId: string }
  /** A literal address — an invitee, who is by definition not a member yet. */
  | { kind: "email"; email: string }
  /**
   * The DEPLOYMENT's own staff (`BILLING_OPERATOR_EMAILS`), not the workspace's.
   *
   * The one audience on our side of the transaction. An ask to move onto a quote-only plan
   * is not something the customer's own admins can answer — there is no price yet — so
   * sending it to them is telling the wrong people about a question only we can settle.
   */
  | { kind: "operators" };

/**
 * Fire an event. Returns immediately; failures are swallowed.
 *
 * This is the type every call site inside the library holds. `undefined` when no notifier is
 * configured, which is why every site calls it as `notify?.(…)` — a deployment that wants no
 * notifications pays nothing, not even the object.
 */
export type Notify = (
  notification: BillingNotification & { id: string; audience?: Audience },
) => void;

// ── The shipped transport ────────────────────────────────────────────────────

const SIGNATURE_VERSION = "v1";

/** `v1,<base64 hmac>` over `<id>.<timestamp>.<body>` — the Svix scheme, because that is what
 *  a consumer's inbound route is most likely to already verify. */
export function signNotification(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `${SIGNATURE_VERSION},${mac}`;
}

/**
 * Verify a signature the way a receiver should: constant-time, and inside a replay window.
 *
 * Exported so a consumer's route does not hand-roll it. The one that did (an inbound email
 * webhook) got it right, and the second one to try would be the one that skipped the
 * timestamp check.
 */
export function verifyNotification(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  opts: { toleranceSec?: number; now?: number } = {},
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.now ?? Date.now();
  // A replay window, because a valid signature is valid for ever without one.
  if (Math.abs(now - ts) > (opts.toleranceSec ?? 300) * 1000) return false;
  const expected = signNotification(secret, id, ts, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WebhookNotifierOptions {
  /** Where to POST. The consumer's own route, usually. */
  endpoint: string;
  /** Shared secret for the signature. Without one the POST is unsigned, which is only ever
   *  right for a localhost endpoint. */
  secret?: string;
  /** Per attempt. Default 5s — a notification must never hold anything open. */
  timeoutMs?: number;
  /** Attempts after the first. Default 2, backing off 250ms then 500ms. */
  retries?: number;
  /** Extra headers (an auth header for a gateway, say). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * Deliver over HTTP, signed.
 *
 * Shipped rather than left to each consumer because the interesting parts are not the POST:
 * they are the timeout (a hung endpoint must not hold a metered call open), the retry
 * (a notification is worth one more try and not ten), and the signature (the receiver has to
 * be able to tell the library from anyone else who learned the URL). Two consumers writing
 * that twice is two chances to get the replay window wrong.
 *
 * 4xx is NOT retried: the receiver understood and refused, and repeating it just doubles the
 * refusals. 5xx and network failures are.
 */
export function webhookNotifier(opts: WebhookNotifierOptions): Notifier {
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  return {
    async deliver(notification) {
      const body = JSON.stringify(notification);
      const at = notification.at;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "billing-notification-id": notification.id,
        "billing-notification-timestamp": String(at),
        ...(opts.secret ? { "billing-notification-signature": signNotification(opts.secret, notification.id, at, body) } : {}),
        ...opts.headers,
      };

      let lastError: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
        try {
          const res = await doFetch(opts.endpoint, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) return;
          // The receiver understood and said no. Retrying cannot change its mind.
          if (res.status >= 400 && res.status < 500) return;
          lastError = new Error(`notification endpoint answered ${res.status}`);
        } catch (e) {
          lastError = e;
        }
      }
      // Exhausted. Throwing here is correct — `emitter` below is what swallows it, and a
      // consumer calling `deliver` directly (a test, a custom transport) deserves the error.
      throw lastError ?? new Error("notification delivery failed");
    },
  };
}

/** For a consumer that wants an id and has nothing stable to derive one from. */
export function notificationId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
