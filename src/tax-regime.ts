import type { LocalTaxOrigin } from "./tax-origins.js";
import type { TaxNotes, TaxRegistration } from "./tax.js";
import type { BillingConfig } from "./types.js";

// The three facts a seller actually knows about itself, mapped onto the tax config.
//
// The engine's model is already expressive enough for every regime a European small
// business goes through — verified, not assumed: `registrations` plus `oss` express
// "exempt at home, destination VAT across the EU, registered in the UK" exactly. What
// it is not is OBVIOUS. Reaching that state means knowing that omitting your own
// country from `registrations` is how you say the domestic supply is exempt, and that
// `oss: true` unions the member states in independently of that list. Two facts about
// a data structure, standing between a developer and a correct charge.
//
// So this maps the three things they can answer without a tax adviser — where am I
// established, am I VAT-registered there, and where else do I collect — onto the same
// object. It adds no capability: `sellerRegime(...)` returns a plain `config.tax`, and
// anything it can express you can still write by hand.

export interface SellerRegime {
  /**
   * Where the business is established. Decides domestic vs cross-border, which is the
   * whole question a VAT rate turns on.
   */
  country: LocalTaxOrigin;
  /**
   * Is the business VAT-registered in its own country?
   *
   * `false` is the small-business exemption — France's franchise en base (art. 293 B
   * CGI), Germany's Kleinunternehmerregelung, Italy's regime forfettario. It means no
   * VAT on domestic sales, and it is a DOMESTIC relief only: it cannot exempt you from
   * VAT owed in another country, which is what `oss` and `alsoCollectIn` are for.
   */
  vatRegistered: boolean;
  /**
   * Registered for the EU One-Stop Shop.
   *
   * OSS is one registration covering every member state, so it is a flag rather than a
   * list: cross-border B2C in the EU is charged at the CUSTOMER's rate and declared in
   * a single return. Required once cross-border EU B2C passes €10 000 a year.
   *
   * Below that threshold, leave it off: the place of supply stays your own country, so
   * an unregistered seller charges nothing and a registered one charges its own rate.
   */
  oss?: boolean;
  /**
   * Everywhere else you have taken on an obligation to collect — the countries OSS
   * does not cover and no dataset can infer.
   *
   * `{ country: "GB" }` for a UK VAT registration (needed from the FIRST sale of a
   * digital service to a UK consumer: the £90 000 threshold does not apply to a
   * non-established business), `{ country: "US", state: "CA" }` for US nexus.
   *
   * Nothing is charged where you are not registered, so this list is also the honest
   * answer to "can I sell there yet".
   */
  alsoCollectIn?: readonly TaxRegistration[];
  /**
   * The mandatory wording for an exempt or reverse-charged line, in your language.
   *
   * Not decoration: a missing "art. 293 B" mention is €15 per invoice in France, and
   * CJEU C-247/21 held that an omitted reverse-charge mention cannot be cured after
   * the fact.
   */
  notes?: TaxNotes;
}

/**
 * Build `config.tax` from what a seller knows about itself.
 *
 * ```ts
 * // A French micro-entreprise, not registered anywhere: 0% to everyone.
 * tax: sellerRegime({ country: "FR", vatRegistered: false })
 *
 * // Same business past €10 000 of EU B2C, and now UK-registered: still 0% at home,
 * // destination rates across the EU, 20% to UK consumers.
 * tax: sellerRegime({ country: "FR", vatRegistered: false, oss: true, alsoCollectIn: [{ country: "GB" }] })
 * ```
 *
 * What it does NOT do is decide whether any of that is true — crossing €10 000, or
 * owing UK VAT, is a fact about your turnover that no library can see. `checkBillingSetup`
 * reports what the config claims; it cannot audit it.
 */
export function sellerRegime(regime: SellerRegime): BillingConfig["tax"] {
  const { country, vatRegistered, oss, alsoCollectIn = [], notes } = regime;

  // The domestic registration is in the list only when the business actually has one.
  // Omitting it is how "the domestic supply is exempt" is said — and the reason this
  // helper exists, because that is not a thing anyone guesses.
  const registrations: TaxRegistration[] = [
    ...(vatRegistered ? [{ country }] : []),
    ...alsoCollectIn,
  ];

  return {
    mode: "local",
    origin: country,
    registrations,
    // OSS covers the member states on top of the list above, so it stays independent
    // of it: a business can be exempt at home and still owe destination VAT abroad.
    oss: oss ?? false,
    ...(notes ? { notes } : {}),
  };
}
