import { getStripe } from "./billing.js";

// Which payment methods a form offers, provisioned from code.
//
// This is the only lever there is. Link cannot be turned off per request: there
// is no `link: false` on a SetupIntent or a Checkout Session, and setting
// `payment_method_types: ["card"]` does NOT remove it — Link's inline signup ("Save
// my info for faster checkout") is drawn by the Payment Element from the ACCOUNT's
// Link setting, independently of the intent's method list. Stripe's own answer is a
// Payment Method Configuration with Link off, passed by id as
// `payment_method_configuration`.
//
// Provisioned rather than clicked, in the same spirit as `ensurePlans` and
// `ensureMeters`: a Dashboard toggle is invisible to a reader of this repo, does
// not travel between the sandbox and live, and cannot be reviewed.
//
// Removing Link also collapses the Payment Element's chrome. With Card AND Link
// available it renders an accordion — a "Card" header with an icon that the
// customer has to look past. With Card alone there is nothing to choose, so the
// card fields render bare.

/** A method's key on the configuration object, e.g. `card`, `link`, `apple_pay`. */
type MethodKey = string;

export interface PaymentMethodConfigOptions {
  /**
   * Stable name, and the idempotency key: an existing ACTIVE configuration with
   * this name is reused rather than a second one created.
   */
  name: string;
  /**
   * Force these off; every other method follows the account's default
   * configuration. Use this to remove one method without listing all the others,
   * so a method enabled in the Dashboard later still reaches checkout.
   */
  disable?: readonly MethodKey[];
  /**
   * Only these on, everything else off. Wins over `disable`. Use it for a form
   * that must offer exactly one thing — saving a card for later, say, where
   * offering Klarna would be nonsense.
   */
  only?: readonly MethodKey[];
}

// One resolution per name per process: this runs on the hot path of rendering a
// payment form, and the answer only changes when someone edits the config.
const cache = new Map<string, Promise<string>>();

/** Methods currently ON in the account's default configuration. */
async function defaultOnMethods(): Promise<MethodKey[]> {
  const stripe = getStripe();
  for await (const config of stripe.paymentMethodConfigurations.list({ limit: 100 })) {
    if (!config.is_default) continue;
    return Object.entries(config as unknown as Record<string, unknown>)
      .filter(([, v]) => {
        const pref = (v as { display_preference?: { value?: string } } | null)?.display_preference;
        return pref?.value === "on";
      })
      .map(([k]) => k);
  }
  // No default reported (a brand-new account, or a restricted key): card is the
  // only method this library can assume, and assuming it is better than
  // provisioning a configuration that offers nothing at all.
  return ["card"];
}

/**
 * Create (or reuse) a payment-method configuration and return its id.
 *
 * Idempotent by `name`. Pass the result as `payment_method_configuration` on a
 * SetupIntent, PaymentIntent or Checkout Session.
 */
export function ensurePaymentMethodConfig(opts: PaymentMethodConfigOptions): Promise<string> {
  const key = `${opts.name}|${(opts.only ?? []).join(",")}|${(opts.disable ?? []).join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const promise = (async () => {
    const stripe = getStripe();
    for await (const config of stripe.paymentMethodConfigurations.list({ limit: 100 })) {
      if (config.active && config.name === opts.name) return config.id;
    }

    // A NEW configuration inherits nothing: every method it does not name is off.
    // That is the trap here — created with only `link: off`, it silently turned
    // Apple Pay off too, which would have quietly removed a wallet from checkout.
    const on = opts.only ? [...opts.only] : await defaultOnMethods();
    const off = opts.only ? [] : (opts.disable ?? []);

    const params: Record<string, unknown> = { name: opts.name };
    for (const method of on) {
      if (off.includes(method)) continue;
      params[method] = { display_preference: { preference: "on" } };
    }
    for (const method of off) {
      params[method] = { display_preference: { preference: "off" } };
    }

    const created = await stripe.paymentMethodConfigurations.create(
      params as unknown as Parameters<typeof stripe.paymentMethodConfigurations.create>[0],
    );
    return created.id;
  })();

  cache.set(key, promise);
  // A failed lookup must not be cached, or one transient error disables the
  // configuration for the life of the process.
  promise.catch(() => cache.delete(key));
  return promise;
}

/** Forget resolved configurations — for a test, or after editing one. */
export function invalidatePaymentMethodConfigs(): void {
  cache.clear();
}
