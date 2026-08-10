// `@arnaudjnn/billing-tools/notifications` — the wire format, with NOTHING behind it.
//
// The half a RECEIVER needs. A consumer's inbound route has to verify a signature and read
// an event; importing that from the root barrel would pull Stripe, WorkOS, the MCP SDK and
// authkit into a route whose entire job is to render an email. Same reasoning as `/plans`,
// and the same purity: this graph imports no external package at all.
//
// NOT here, deliberately: `createEmitter` (it takes the storage adapter, which is the
// opposite of pure) — import it from the root, where a hand-wired composition lives anyway.
export {
  notificationId,
  signNotification,
  verifyNotification,
  webhookNotifier,
  type Audience,
  type BillingNotification,
  type DeliverableNotification,
  type NotifiedMember,
  type NotifiedWindow,
  type Notifier,
  type Notify,
  type WebhookNotifierOptions,
} from "../notifications/index.js";
