## [15.15.2](https://github.com/arnaudjnn/billing-tools/compare/v15.15.1...v15.15.2) (2026-08-05)


### Bug Fixes

* **deps:** move commander in the lockfile, so CI can install again ([120f1d5](https://github.com/arnaudjnn/billing-tools/commit/120f1d50abeb5d815544a8e0765ad1bc8333838e))

## [15.15.1](https://github.com/arnaudjnn/billing-tools/compare/v15.15.0...v15.15.1) (2026-08-05)


### Bug Fixes

* **subscription:** four plan-change defects a real Stripe request surfaces ([5f875a5](https://github.com/arnaudjnn/billing-tools/commit/5f875a5777015f0784a7b4f9f9eba15fe8f7f664))

# [15.15.0](https://github.com/arnaudjnn/billing-tools/compare/v15.14.0...v15.15.0) (2026-08-05)


### Features

* **routes:** let a route carry a principal, and answer 403 with 403 ([6c15bba](https://github.com/arnaudjnn/billing-tools/commit/6c15bba8c67608bc723126b1a6ce0fe3d64cda23))

# [15.14.0](https://github.com/arnaudjnn/billing-tools/compare/v15.13.0...v15.14.0) (2026-08-05)


### Features

* **tax:** remove mode "external" ([0d41f10](https://github.com/arnaudjnn/billing-tools/commit/0d41f10dc6d96776a1e05b4e409e2171c89e9c50))

# [15.13.0](https://github.com/arnaudjnn/billing-tools/compare/v15.12.0...v15.13.0) (2026-08-05)


### Features

* **checkout:** expose taxIdRequired, and record what it cannot do ([79b3d3a](https://github.com/arnaudjnn/billing-tools/commit/79b3d3a90c966c63632e222db8184bb59e63be4d))

# [15.12.0](https://github.com/arnaudjnn/billing-tools/compare/v15.11.0...v15.12.0) (2026-08-05)


### Features

* **tax:** put the supplier's own VAT number on the invoice ([5848fec](https://github.com/arnaudjnn/billing-tools/commit/5848fec38b5e5871af31f2cce51780b57a6abed7))

# [15.11.0](https://github.com/arnaudjnn/billing-tools/compare/v15.10.1...v15.11.0) (2026-08-05)


### Features

* **tax:** one file for where a non-established seller owes tax ([cd6299b](https://github.com/arnaudjnn/billing-tools/commit/cd6299b9dd980b0e521f8d0aaa7f28593dc11338))

## [15.10.1](https://github.com/arnaudjnn/billing-tools/compare/v15.10.0...v15.10.1) (2026-08-05)


### Bug Fixes

* **plans:** put sellerRegime on the /plans leaf, where it is used ([c318747](https://github.com/arnaudjnn/billing-tools/commit/c3187470535154bcbe0301027c9fdd93de1e9bb2))

# [15.10.0](https://github.com/arnaudjnn/billing-tools/compare/v15.9.0...v15.10.0) (2026-08-05)


### Features

* **tax:** collect the address on a top-up, and one front door for the regime ([e7bcaf1](https://github.com/arnaudjnn/billing-tools/commit/e7bcaf1cc740e143b05fb4bf9576b0efdfb336de))

# [15.9.0](https://github.com/arnaudjnn/billing-tools/compare/v15.8.0...v15.9.0) (2026-08-05)


### Features

* **doctor:** an undeclared origin on a non-European account is an error ([cdf9c06](https://github.com/arnaudjnn/billing-tools/commit/cdf9c06a56b1712390e046aa084fcc111468e3e3))

# [15.8.0](https://github.com/arnaudjnn/billing-tools/compare/v15.7.0...v15.8.0) (2026-08-05)


### Features

* **doctor:** warn when the declared tax origin contradicts the account ([739b92b](https://github.com/arnaudjnn/billing-tools/commit/739b92b481c344f1875cff475e6c8b143d05ab5b))

# [15.7.0](https://github.com/arnaudjnn/billing-tools/compare/v15.6.1...v15.7.0) (2026-08-05)


### Features

* **cli:** gate the commands by the catalogue, like the tools ([286db70](https://github.com/arnaudjnn/billing-tools/commit/286db7084097a6ae8498f7ae33cd39b741aa37a5))

## [15.6.1](https://github.com/arnaudjnn/billing-tools/compare/v15.6.0...v15.6.1) (2026-08-05)


### Bug Fixes

* **cli:** drop commander — describe the shape instead of depending on it ([fe2c3c1](https://github.com/arnaudjnn/billing-tools/commit/fe2c3c1a65c1b269f3d887b623e182f821bc1a90))

# [15.6.0](https://github.com/arnaudjnn/billing-tools/compare/v15.5.1...v15.6.0) (2026-08-05)


### Features

* **doctor:** read the webhook URL from BILLING_WEBHOOK_URL ([7478b9b](https://github.com/arnaudjnn/billing-tools/commit/7478b9b2e59d3103a024611c56d65ccb7dc5d46c))

## [15.5.1](https://github.com/arnaudjnn/billing-tools/compare/v15.5.0...v15.5.1) (2026-08-05)


### Bug Fixes

* **doctor:** print the manual redirect URI on the verb people actually run ([3106015](https://github.com/arnaudjnn/billing-tools/commit/3106015771495f0560c318b2cf30ef6ee829929b))

# [15.5.0](https://github.com/arnaudjnn/billing-tools/compare/v15.4.0...v15.5.0) (2026-08-05)


### Features

* **workos:** provision the roles, and print what cannot be provisioned ([18e37d4](https://github.com/arnaudjnn/billing-tools/commit/18e37d4d3c4596b6f95cb4dccefc6dbcc98bf47b))

# [15.4.0](https://github.com/arnaudjnn/billing-tools/compare/v15.3.0...v15.4.0) (2026-08-05)


### Features

* **routes:** 402 for an empty wallet, and an option to gate the MCP handshake ([4577b7a](https://github.com/arnaudjnn/billing-tools/commit/4577b7a05b23f31562d20969b61dc9fe7e49ce59))

# [15.3.0](https://github.com/arnaudjnn/billing-tools/compare/v15.2.3...v15.3.0) (2026-08-05)


### Features

* **create-billing:** derive the billing script's options from the composition ([f5bb51b](https://github.com/arnaudjnn/billing-tools/commit/f5bb51b8ca26243ce4c2416643349f73592a0182))

## [15.2.3](https://github.com/arnaudjnn/billing-tools/compare/v15.2.2...v15.2.3) (2026-08-04)


### Bug Fixes

* **doctor:** a WorkOS key that doesn't name its environment isn't production ([8d02e39](https://github.com/arnaudjnn/billing-tools/commit/8d02e3975ef3d9084f4bc08b5e4b96936c3a8f18))

## [15.2.2](https://github.com/arnaudjnn/billing-tools/compare/v15.2.1...v15.2.2) (2026-08-04)


### Bug Fixes

* **checkout:** let a caller actually pass `config`, and pass it from changePlan ([4049c09](https://github.com/arnaudjnn/billing-tools/commit/4049c098eb248688734f89ac1bec8acb50fe519f))

## [15.2.1](https://github.com/arnaudjnn/billing-tools/compare/v15.2.0...v15.2.1) (2026-08-04)


### Bug Fixes

* **tools:** default change_plan's returnUrl to config.baseUrl ([1f693c1](https://github.com/arnaudjnn/billing-tools/commit/1f693c1c622a07ca758c8e2cde6d4099d1b80d9d))

# [15.2.0](https://github.com/arnaudjnn/billing-tools/compare/v15.1.0...v15.2.0) (2026-08-04)


### Features

* **checkout:** a hosted seat session, so an agent can finish a purchase ([7f1d1fe](https://github.com/arnaudjnn/billing-tools/commit/7f1d1fe6f772d612e2449fe41ff2a0435d198fb2))

# [15.1.0](https://github.com/arnaudjnn/billing-tools/compare/v15.0.0...v15.1.0) (2026-08-04)


### Features

* **doctor:** one runner with two verbs, and catch a mixed key pair ([fd9c0b8](https://github.com/arnaudjnn/billing-tools/commit/fd9c0b8cde403426dafbe46820756be45c381fc5))

# [15.0.0](https://github.com/arnaudjnn/billing-tools/compare/v14.0.0...v15.0.0) (2026-08-04)


* fix(tax)!: remove the Numeral adapter — it could not have worked ([a028985](https://github.com/arnaudjnn/billing-tools/commit/a028985131fc2e37849c8ebd47991adf2be9994e))


### BREAKING CHANGES

* `numeralTax` and `NumeralOptions` are removed. Wire your own
`calculate` — but read the note on `TaxCalculator` first: a provider that needs the
basket cannot be reached through this seam yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [14.0.0](https://github.com/arnaudjnn/billing-tools/compare/v13.1.0...v14.0.0) (2026-08-04)


* feat(tax)!: a provider mode, and make an uncomputable `local` origin unwritable ([292b10c](https://github.com/arnaudjnn/billing-tools/commit/292b10c36835ec9701d742f88e403f2e9bc0252b))


### BREAKING CHANGES

* `config.tax` is a union rather than an open object. `mode: "local"`
(including by default) now requires `origin` to be one of the 45 countries the local
engine has rates for; `LOCAL_TAX_ORIGINS` and `isLocalTaxOrigin` are exported for
checking at runtime. A deployment whose establishment is elsewhere must move to
`mode: "stripe"` or `mode: "external"` — it was already being refused at charge time.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [13.1.0](https://github.com/arnaudjnn/billing-tools/compare/v13.0.0...v13.1.0) (2026-08-04)


### Features

* **tax:** support a small-business exemption, and the invoice wording it requires ([be0abf0](https://github.com/arnaudjnn/billing-tools/commit/be0abf0bd438e2dfdc8e51674a49f3d33e3122d1))

# [13.0.0](https://github.com/arnaudjnn/billing-tools/compare/v12.0.1...v13.0.0) (2026-08-04)


* feat!: remove three deprecated options, and the stale references deleted features left ([7200ec9](https://github.com/arnaudjnn/billing-tools/commit/7200ec913d8ef0f2eb2d1703d332e97e70891dac))


### Performance Improvements

* **tax:** remember VAT numbers VIES has confirmed ([9a1af68](https://github.com/arnaudjnn/billing-tools/commit/9a1af68bf5dfd02c265fa7dc1048fbf64cf219fb))


### BREAKING CHANGES

* `checkBillingSetup({ expectTax })`, `MeterOptions.extraAllowance` and
`DeriveCompareOptions.labels` are removed. `expectTax: true` → `taxMode: "stripe"`,
`false` → `taxMode: "none"`, or pass `config` and let it read `config.tax`. Drop
`extraAllowance` — it has had no effect for several majors. `labels: { unlimited,
separator, monthly, yearly }` → the same four keys under `messages`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [12.0.1](https://github.com/arnaudjnn/billing-tools/compare/v12.0.0...v12.0.1) (2026-08-04)


### Bug Fixes

* **billing:** resolve auto-reload tax only when a reload actually happens ([846455d](https://github.com/arnaudjnn/billing-tools/commit/846455da70d8cdfb3e68fce0f2657e6272920db5))
* **tax:** the VAT id must belong to the country the customer is in ([6620afe](https://github.com/arnaudjnn/billing-tools/commit/6620afe95ea2aca84b0ff6750ae24c95f75983b8))

# [12.0.0](https://github.com/arnaudjnn/billing-tools/compare/v11.0.2...v12.0.0) (2026-08-03)


* feat(tax)!: declare where you are registered, and stop charging tax nobody can remit ([a411b7f](https://github.com/arnaudjnn/billing-tools/commit/a411b7f85c82013449963597b4f2f79d20eaf467))


### BREAKING CHANGES

* `config.tax.allowApproximate` is removed. Its only remaining use
was to under-collect silently: since the move off `sales-tax` there has been no
non-European rate to approximate WITH, so it never applied a figure, it only
decided whether 0% went out quietly — while the error message claimed otherwise.
With `registrations` both its cases collapse: where you are not registered,
`registrations` answers 0% completely and needs no permission; where you are,
suppressing the throw invoices 0% on tax you owe, the one unrecoverable direction.
Migration: delete it; `registrations: []` reproduces the 0% while stating why, and
`mode: "none"` reproduces it for an account that charges no tax anywhere.

Also makes the VIES lookup injectable (`__setVatValidatorForTests`). The
reverse-charge tests asserted on a real German company's live registration status,
so the suite went red whenever a member state's node returned MS_UNAVAILABLE — the
exact outage the charge-rather-than-exempt fallback exists for, and the one
behaviour untestable while the test WAS the outage. The reset now installs a
validator that REFUSES rather than the real one, so a future test written with a
`taxNumber` and no stub fails deterministically with a message saying what to do,
instead of silently re-arming the network and flaking months later. The local
format check stays outside the seam: a stub that also accepted malformed numbers
would test a laxer function than ships.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## [11.0.2](https://github.com/arnaudjnn/billing-tools/compare/v11.0.1...v11.0.2) (2026-08-03)


### Bug Fixes

* **usage:** retry the write, bound the last unbounded scan, pin multi-instance ([7344ac9](https://github.com/arnaudjnn/billing-tools/commit/7344ac9033e460acb9ca65226557f2090b669a30))

## [11.0.1](https://github.com/arnaudjnn/billing-tools/compare/v11.0.0...v11.0.1) (2026-08-03)


### Bug Fixes

* **usage:** report the two failure paths that load-testing found still silent ([2e914b1](https://github.com/arnaudjnn/billing-tools/commit/2e914b1a87533de5e095849e0520f40a834f4f75))

# [11.0.0](https://github.com/arnaudjnn/billing-tools/compare/v10.1.0...v11.0.0) (2026-08-03)


* feat(usage)!: one policy for a failed read, and a channel that reports it ([6a382a8](https://github.com/arnaudjnn/billing-tools/commit/6a382a81664bdac0e080b7c501e07e73ba5ce367))


### BREAKING CHANGES

* `stripeScopeUsageLedger.total` now propagates read errors instead
of returning 0, so the policy can act on them. Wrapped in `stripeUsageLedger` (the
documented composition, and what `defaultUsageLedger` builds) behaviour is
unchanged by default apart from serving last-known where one exists. A consumer
driving the scope ledger directly should wrap it or handle rejection.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

# [10.1.0](https://github.com/arnaudjnn/billing-tools/compare/v10.0.0...v10.1.0) (2026-08-03)


### Features

* **tax:** `oss` — whose rate a cross-border EU sale carries without a VAT id ([cf71d84](https://github.com/arnaudjnn/billing-tools/commit/cf71d844e1f705eaca729b6d03c078484d642e9e))

# [10.0.0](https://github.com/arnaudjnn/billing-tools/compare/v9.0.0...v10.0.0) (2026-08-03)


* fix(tax)!: a European seller exporting outside the EU is out of scope, not unknown ([9f1f3ea](https://github.com/arnaudjnn/billing-tools/commit/9f1f3ea6670b7124c32d3c50ee18bdcb1879c7eb))


### BREAKING CHANGES

* `TaxDecision` gains `outOfScope`, and a non-European destination
is no longer `approximate` when the seller is European.

The previous version marked EVERY destination outside the 45 covered countries as
`approximate` and refused it, regardless of where the seller was. That is right for
a seller whose own regime we have no rates for, and wrong — badly — for a European
one: it would have refused every export a French business made.

The place of supply for a digital service is the customer's country. If that is
outside the EU, no EU VAT arises: 0% is correct and COMPLETE, which is what
`outOfScope` says. `approximate` now means only "we cannot compute this seller's
regime", where 0% would be a guess.

  FR -> US / CA / AU / JP    0%, outOfScope, charged
  US -> US                   0%, approximate, refused
  FR -> IT                   22% IVA
  FR -> FR                   20% TVA

A separate obligation can still arise in the destination once a nexus threshold is
crossed; that is a registration question, not a rate this library can compute, and
`checkBillingSetup` warns on US customers for exactly that reason.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [9.0.0](https://github.com/arnaudjnn/billing-tools/compare/v8.0.1...v9.0.0) (2026-08-03)


* feat!: replace sales-tax with eu-vat-rates-data, and refuse what we cannot rate ([54c188c](https://github.com/arnaudjnn/billing-tools/commit/54c188c63f4d4e05658b52b008e64adfeccb0787))


### BREAKING CHANGES

* the `sales-tax` dependency is gone. Rate coverage is now the 45
European countries `eu-vat-rates-data` tracks daily from the European Commission's
TEDB. Any destination outside them — including the US, Canada, Australia, Japan —
resolves as `approximate` and is REFUSED by `taxRatesFor` unless
`config.tax.allowApproximate` is set. Use `mode: "stripe"` for those.

Three things got better and one got smaller.

Better: the rates are authoritative and fresh. `sales-tax` shipped a static JSON
published whenever someone cut a release; this is date-versioned from the EC's own
database. It also carries EU MEMBERSHIP, so reverse charge is now three stated
conditions — both in the EU, different countries, a VAT number that stands up —
instead of a library's opinion we took on trust. And `vat_abbr` gives the country's
own word for the tax, so an Italian invoice says IVA and a French one TVA without
the app supplying a map.

VIES is now called directly (~25 lines) rather than through the old dependency,
with the same safe direction kept and now written down: format-checked locally
first so a shared public service is only asked about numbers that could be real,
4s timeout because it sits on a checkout path, and an unverifiable number is NOT
an exemption. A wrongly charged customer asks for it back; a wrongly exempted one
leaves you owing the VAT.

Smaller: `sales-tax` carried a rate for 86 non-European countries and this does
not. That is the point rather than a regression — a number with no authority
behind it invoices confidently and under-collects silently, which is the one
direction that is not recoverable. The US guard added in 0b8bbd6 now covers all of
them on the same footing, and the decision no longer carries a misleading rate at
all: it is 0% + `approximate`, so there is no number to leak past the flag if a
caller forgets to check it.

Verified live: FR→FR 20% TVA, FR→IT 22% IVA, FR→NO 25% MVA, FR→GB 20%, IT→IT does
not reverse-charge (no border), FR→DE with a real VAT number reverse-charges to 0%
while a bogus one charges 19%, and FR→US / FR→CA refuse.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [8.0.1](https://github.com/arnaudjnn/billing-tools/compare/v8.0.0...v8.0.1) (2026-08-03)


### Bug Fixes

* **doctor:** US tax exposure is about the CUSTOMER's country, not ours ([36c47b8](https://github.com/arnaudjnn/billing-tools/commit/36c47b852c552efe832e485c0b9cb46bb7dcc2dc))

# [8.0.0](https://github.com/arnaudjnn/billing-tools/compare/v7.0.0...v8.0.0) (2026-08-03)


* feat!: refuse a knowingly-approximate US tax rate instead of applying it ([0b8bbd6](https://github.com/arnaudjnn/billing-tools/commit/0b8bbd65dc9269ba9de73f3e904497f77282457c))


### BREAKING CHANGES

* under `mode: "local"`, a US-destination charge now throws
`ApproximateTaxError` unless `config.tax.allowApproximate: true`.

`sales-tax` carries ONE rate per US state. US sales tax is destination-based
across 13 000+ jurisdictions — counties, cities and special districts stack on the
state rate — and SaaS is taxable in some states and not others. Illinois reads
6.25% where a Chicago buyer owes ~10.25%. So the number was not slightly rough; it
was four points short, on every invoice, silently.

Under-collection is the one direction that is not recoverable. Charge too much and
a customer asks for it back; charge too little and the difference is yours at
audit, with interest, long after they are gone. That is the same reasoning already
applied to an unverifiable VAT number, where this library charges rather than
exempts — extended to the case where the RATE, not the exemption, is the guess.

`TaxDecision.approximate` marks it (US only), `taxRatesFor` refuses to mint from
it, `taxFor` threads the opt-out, and `checkBillingSetup` warns at deploy time
when the origin is US without it — the only place the choice can usefully be
raised, since at charge time it has already been made and on an invoice it is
invisible.

This is not a gap a dependency can close, which is why the guard is the answer.
Checked against npm: `taxjar` is a client for a paid API, `washington-state-sales-tax`
covers one state, `eu-vat-rates-data` is EU-only, `@medusajs/tax` is plumbing.
Nothing ships accurate US local rates, because the data is a licensed product —
Avalara and TaxJar sell exactly it. EU VAT is tractable for the opposite reason:
27 countries, one published rate each.

Coverage: the refusal, the flag and the EU non-regression are unit-tested. The
doctor's warning branch is not — `doctor.test.mjs` exercises `checkPlansConfig`
only, and a full Stripe fake for `checkBillingSetup` was more than the branch
warranted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [7.0.0](https://github.com/arnaudjnn/billing-tools/compare/v6.0.0...v7.0.0) (2026-08-03)


* perf(usage)!: answer a caller's windows in one request, and drop wallet: null ([a74ef20](https://github.com/arnaudjnn/billing-tools/commit/a74ef202bd796c9617279fa7cc0998c97c83fbfa))


### BREAKING CHANGES

* `stripeScopeUsageLedger({ wallet: null })` is removed. It was a
per-DEPLOYMENT switch for a per-QUERY fact: the same plan can have a member window
that overflows into the wallet and an agent window that is wallet-only, so one flag
could not be right for both, and setting it wrong under-reported — which reads as
generosity and refuses no one. `UsageQuery.sources` carries it per read and
`resolveAllowance` derives it from the plan (`capCovers` / `exhaustedPolicy`), so
nothing has to be declared by hand. Consumers driving the ledger directly pass
`sources` on the query.

Also fixes an imprecision this surfaced: stripeBalanceUsageLedger.total went
through `usageSince`, which has no upper bound and summed past a CLOSED window's
end. No gate hit it (a current window always ends in the future) but a historical
read would have; both paths now share one bounded walk.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

# [6.0.0](https://github.com/arnaudjnn/billing-tools/compare/v5.1.0...v6.0.0) (2026-08-03)


* feat!: rename the tax mode "billing-tools" to "local" ([6d8bed9](https://github.com/arnaudjnn/billing-tools/commit/6d8bed9ff4100812bc13504dd6fb120421f43a30))


### BREAKING CHANGES

* `config.tax.mode` and `checkBillingSetup({ taxMode })` take
`"local"` where they took `"billing-tools"`. The values are now
`"local" | "stripe" | "none"`.

The old name came from matching the `managedBy: "billing-tools"` marker this
library stamps on everything it mints, which is a fact about the implementation
rather than about the choice a developer is making. `"local"` names the thing that
actually distinguishes it: the rate is computed in-process, from `sales-tax` plus a
VIES lookup, with no per-transaction fee and no registration needed to calculate.

Deliberately NOT `"auto"`. Stripe's own field is `automatic_tax` and Stripe Tax is
sold as automatic tax, so `"auto"` would name this mode after the one thing it is
the alternative to — the reading a developer is most likely to get backwards. A
mode name that inverts its own meaning is worse than a clumsy one.

The `managedBy: "billing-tools"` marker, the MCP/REST `realm` default and the
Stripe-CLI cache directory all keep the old string: they are the package's
identity, not the tax mode, and three of the six occurrences in src/ were exactly
those.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [5.1.0](https://github.com/arnaudjnn/billing-tools/compare/v5.0.0...v5.1.0) (2026-08-03)


### Features

* **usage:** let a read say which funding sources it can contain ([6826443](https://github.com/arnaudjnn/billing-tools/commit/6826443c8f1a41a12a3f8629bd722b9a0c90514e))

# [5.0.0](https://github.com/arnaudjnn/billing-tools/compare/v4.1.0...v5.0.0) (2026-08-03)


* feat!: calculate tax by DEFAULT, with the origin resolved in one place ([31017c9](https://github.com/arnaudjnn/billing-tools/commit/31017c9c1cd2cd54e073508953c181a224de519a))


### BREAKING CHANGES

* `taxModeOf(undefined)` now returns `"billing-tools"` instead of
`"none"`. A deployment that configures no tax now has this library calculate it
(`sales-tax` + VIES, applied as explicit Stripe TaxRates) rather than charging
none. `mode: "none"` is how you opt out.

The old default was the expensive direction. Silence meant no tax on anything the
library charged, so a deployment that never thought about VAT shipped charging
none of it — and over-charging is recoverable while under-collecting means owing
it yourself, with interest, in every jurisdiction you sold into. "I did not
configure tax" is not a statement that the sale is untaxed. gtm-tools was in
exactly that state: its setup report read `Tax: mode is "none"`.

What made the default impossible before was `origin`: the mode needs to know where
you are established and no rate exists without it. `originFor` removes that —
`config.tax.origin`, else the Stripe ACCOUNT's country, which is the country you
gave Stripe at signup and the best available answer. Memoised once per process (an
account does not change country) and it never throws, because it sits behind
`taxFor` on the hot path of every metered call: a Stripe blip must cost a tax
rate, never the charge. A transient failure is not cached, so it retries; a
genuine "no country on the account" is settled and remembered.

That makes it the ONE place the origin is decided. Nothing else in the library may
read `tax.origin` — it decides domestic vs cross-border, which is the whole
question a VAT rate turns on, so a second copy is a second answer. Consumers must
not keep one either: scartoffie has a `const TAX_ORIGIN = "FR"` beside its
`config.tax`, and its `scripts/ops/stripe-tax.ts` still registers `IT` — the two
answers this rule exists to prevent.

`invalidateTaxOrigin()` also re-arms the one-time "no origin" warning, which is
what keeps the "says so once" property testable rather than only asserted in a
comment.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [4.1.0](https://github.com/arnaudjnn/billing-tools/compare/v4.0.0...v4.1.0) (2026-08-03)


### Features

* **doctor:** audit WorkOS, and stop setupBilling from discarding its own report ([2f8f42d](https://github.com/arnaudjnn/billing-tools/commit/2f8f42d23175576c8bb33b49c80e62729ba662ee))


### Performance Improvements

* **allowance:** one customer retrieve, not two — and a load test that found it ([2d70f90](https://github.com/arnaudjnn/billing-tools/commit/2d70f9081b5f957716842add806a17bf5b0e38b0))

# [4.0.0](https://github.com/arnaudjnn/billing-tools/compare/v3.2.0...v4.0.0) (2026-08-03)


* feat!: remove the legacy PlanDef shape ([5c16f82](https://github.com/arnaudjnn/billing-tools/commit/5c16f8282582f53d8c9ca53762b92ca9130f8238))


### BREAKING CHANGES

* `PlanDef`, `PlansConfig`, `SeatTypeDef`, `isLegacyPlan`,
`DEFAULT_SEAT_TYPES` and `PlanModel.legacy` are removed. `PlanCatalog` is now
`Record<string, PlanSpec>`, so a config must declare `sells` / `cap` / `sale`.

It was kept for exactly one reason: both apps declared `PLANS: PlansConfig` and
read `PLANS[k].price.monthly`, so turning `PlanDef` into a union would have
stopped their builds compiling. Both migrated to `definePlans` with `PlanSpec`
long ago, and by 3.1.x the only things still naming the legacy shape were this
library and its own tests — traced across all three repos, the sole hit outside
here was a COMMENT in gtm-tools saying it had stopped using `DEFAULT_SEAT_TYPES`.
Compatibility you are the sole consumer of is not compatibility.

What that was costing: 176 lines of plan-model.ts, a second normalisation branch
running in parallel with the real one, a `legacy: boolean` carried on every
PlanModel, a doctor warning for a state no config could reach, and a
`normalizeSeatTypes` that read every field twice (`max ?? legacy.seats`,
`display ?? legacy.label`) so a reader could never be sure which spelling won.
`normalizePlan` now has one branch.

Both consumers typecheck and pass their suites against this unchanged — 241 and
29 tests — which is the evidence that nothing was using it.

Migration is mechanical, and AGENTS.md carries the table: `seats` ->
`limits.members`, `price` -> `sells.flat`, `seatTypes` -> `sells.seats` (with
`seats` -> `max`, `label` -> `display.label`), `allowanceMode: "per_seat"` ->
`cap: per_seat` + `onExhausted: "block"`, `allowanceMode: "global"` ->
`cap: wallet` (never `pool` — it only ever meant "no per-seat cap", and a pool
would start blocking a live customer), `creditsPerSeat` -> `grant.per_member` or
`cap.pool` depending on which you actually meant. `sale` is now required rather
than guessed from whether any price exists — guessing it is what let a quote-only
plan be bought at its placeholder price.

`sale: "legacy"` is unrelated and stays: a plan kept for existing subscribers and
offered to nobody new.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [3.2.0](https://github.com/arnaudjnn/billing-tools/compare/v3.1.1...v3.2.0) (2026-08-03)


### Features

* **usage:** a cache in front of the ledger, and a way to skip the unbounded read ([d545f1b](https://github.com/arnaudjnn/billing-tools/commit/d545f1bc9cf19dec8c26b8e33f43321dabef1e4b))

## [3.1.1](https://github.com/arnaudjnn/billing-tools/compare/v3.1.0...v3.1.1) (2026-08-03)


### Bug Fixes

* **doctor:** bound the customer scan by objects examined, not by sample size ([70f6ed6](https://github.com/arnaudjnn/billing-tools/commit/70f6ed6d2c5f4946b8e807beb7ff9a5b45ed8d94))

# [3.1.0](https://github.com/arnaudjnn/billing-tools/compare/v3.0.0...v3.1.0) (2026-08-03)


### Features

* **doctor:** runBillingDoctor, the CLI both consumers hand-wrote ([f1218a0](https://github.com/arnaudjnn/billing-tools/commit/f1218a0bbd78662194631e288b83394a7273b498))

# [3.0.0](https://github.com/arnaudjnn/billing-tools/compare/v2.19.0...v3.0.0) (2026-08-03)


* feat!: count per-member usage in Stripe, and delete every store backend ([4c64b7b](https://github.com/arnaudjnn/billing-tools/commit/4c64b7b866231726d883e31ba76ebd189f463cb1))


### BREAKING CHANGES

* the usage stores are removed — `postgresUsageLedger`,
`counterUsageLedger`, `sqlUsageCounters`, `redisUsageCounters`,
`memoryUsageCounters`, `ensureUsageLedgerTable`, `ensureUsageCountersTable`,
`pruneUsageCounters`, `USAGE_EVENTS`, `USAGE_COUNTERS`, their `_DDL` aliases,
`SqlClient`, `SqlCounterClient`, `RedisCounterClient`, `UsageCounterStore`,
`CounterLedgerOptions`, and the `meter.db` / `meter.counters` shortcuts.
They existed for the one question above; a database is no longer the answer to
it. Bring your own `ledger` if you want the per-action audit trail a store keeps.
`scopeOf` / `scopesFor` now come from `usage-scopes.js`.

Also fixes `coverageNeededBy`, which was wrong in BOTH directions against the
reads `resolveAllowance` actually issues: an org-scoped limit carrying
`callerKind` is a per-caller read but was filed under `orgIncluded` (it passed
every check and read 0 for ever), and a caller-scoped limit over usage the wallet
always funds was rejected for needing a store it does not. Both are pinned.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

# [2.19.0](https://github.com/arnaudjnn/billing-tools/compare/v2.18.0...v2.19.0) (2026-08-03)


### Features

* **usage:** memberUsage narrows an api member to its own key ([6ec0b34](https://github.com/arnaudjnn/billing-tools/commit/6ec0b34a3b06a0e849e34c1c05f0247a67ceb03a))

# [2.18.0](https://github.com/arnaudjnn/billing-tools/compare/v2.17.0...v2.18.0) (2026-08-03)


### Features

* **metering:** record WHICH api key made the call, not the org id ([1f55e6a](https://github.com/arnaudjnn/billing-tools/commit/1f55e6a8f55ecce74fb443915061c866b72852d0))

# [2.17.0](https://github.com/arnaudjnn/billing-tools/compare/v2.16.0...v2.17.0) (2026-08-03)


### Features

* **setup:** one command per environment, and one call per deploy ([9ff812f](https://github.com/arnaudjnn/billing-tools/commit/9ff812f56a26c1160a3126030082016d844d44d1))

# [2.16.0](https://github.com/arnaudjnn/billing-tools/compare/v2.15.0...v2.16.0) (2026-08-03)


### Features

* **usage:** export USAGE_COUNTERS / USAGE_EVENTS ([a086e86](https://github.com/arnaudjnn/billing-tools/commit/a086e860b6f70b513e7a3db2966b07ef406679eb))

# [2.15.0](https://github.com/arnaudjnn/billing-tools/compare/v2.14.0...v2.15.0) (2026-08-03)


### Features

* **pricing:** publish the name of the seat a seatless plan gives ([0179d28](https://github.com/arnaudjnn/billing-tools/commit/0179d2834c76e00d29f749377899c8ab9b91b5fe))

# [2.14.0](https://github.com/arnaudjnn/billing-tools/compare/v2.13.0...v2.14.0) (2026-08-03)


### Features

* **usage:** count per-member windows as counters, not events ([acee119](https://github.com/arnaudjnn/billing-tools/commit/acee119e3f0d19a16fa690e4caf221fecf9f3116))

# [2.13.0](https://github.com/arnaudjnn/billing-tools/compare/v2.12.0...v2.13.0) (2026-08-03)


### Features

* **usage:** report the caller's seat, and let a seatless plan name one ([ca743a8](https://github.com/arnaudjnn/billing-tools/commit/ca743a830c7434d172235fcc6acdadfd2ae71e1b))

# [2.12.0](https://github.com/arnaudjnn/billing-tools/compare/v2.11.0...v2.12.0) (2026-08-03)


### Features

* size a pooled allowance per seat type, declare ledger coverage, and make tax one declaration ([c24bdb9](https://github.com/arnaudjnn/billing-tools/commit/c24bdb9f0e893d85c68e4297e2bf3247a25b978b))

# [2.11.0](https://github.com/arnaudjnn/billing-tools/compare/v2.10.2...v2.11.0) (2026-08-03)


### Features

* **usage:** count org-wide windows in Stripe, and pool an allowance per seat ([b9a6fb1](https://github.com/arnaudjnn/billing-tools/commit/b9a6fb11183a129124588fb20e63e0d004ae1efa))

## [2.10.2](https://github.com/arnaudjnn/billing-tools/compare/v2.10.1...v2.10.2) (2026-08-03)


### Bug Fixes

* **seats:** a seat assignment goes on the member, not in a shared metadata value ([f421e14](https://github.com/arnaudjnn/billing-tools/commit/f421e14ec003c1b37af33f3712ab56b92291522a))

## [2.10.1](https://github.com/arnaudjnn/billing-tools/compare/v2.10.0...v2.10.1) (2026-08-03)


### Bug Fixes

* **top-ups:** a grant goes on the member, not in a shared metadata value ([c67ad90](https://github.com/arnaudjnn/billing-tools/commit/c67ad9034ac3792ee123e95cf78a57485a216551))

# [2.10.0](https://github.com/arnaudjnn/billing-tools/compare/v2.9.0...v2.10.0) (2026-08-03)


### Features

* **usage:** ship the SQL usage ledger, and pick it from `meter.db` ([488d146](https://github.com/arnaudjnn/billing-tools/commit/488d14663a80c8674fd6b532b3f11d36d5759c7a))

# [2.9.0](https://github.com/arnaudjnn/billing-tools/compare/v2.8.0...v2.9.0) (2026-08-03)


### Features

* **allowance:** enforce a customer-set monthly spend limit ([550253c](https://github.com/arnaudjnn/billing-tools/commit/550253c1ff579bc7680a715ce0d056ac0abdf74e))

# [2.8.0](https://github.com/arnaudjnn/billing-tools/compare/v2.7.1...v2.8.0) (2026-08-02)


### Features

* **billing:** savePaymentMethod option for the top-up checkout ([7b1d210](https://github.com/arnaudjnn/billing-tools/commit/7b1d2104786ff445100441b904bb80532c96201f))

## [2.7.1](https://github.com/arnaudjnn/billing-tools/compare/v2.7.0...v2.7.1) (2026-08-02)


### Bug Fixes

* **payment-methods:** setup mode rejects saved_payment_method_options ([41a26e8](https://github.com/arnaudjnn/billing-tools/commit/41a26e8844e90fe2db2cb322791fd4aa750245b0))

# [2.7.0](https://github.com/arnaudjnn/billing-tools/compare/v2.6.1...v2.7.0) (2026-08-02)


### Features

* **payment-methods:** save a card through a setup-mode Checkout Session ([112e0f0](https://github.com/arnaudjnn/billing-tools/commit/112e0f0bfa5ccda2dba2623372f2eac54bfdd132))

## [2.6.1](https://github.com/arnaudjnn/billing-tools/compare/v2.6.0...v2.6.1) (2026-08-02)


### Reverts

* Revert "feat(ui): let a caller collapse the address behind its own summary" ([29e35ef](https://github.com/arnaudjnn/billing-tools/commit/29e35ef5c572ad89be7795ee9621636e26fb4362))

# [2.6.0](https://github.com/arnaudjnn/billing-tools/compare/v2.5.1...v2.6.0) (2026-08-02)


### Features

* **ui:** let a caller collapse the address behind its own summary ([00b81d6](https://github.com/arnaudjnn/billing-tools/commit/00b81d658dbb1b2bdfc648d37e3f8ecced770f0b))

## [2.5.1](https://github.com/arnaudjnn/billing-tools/compare/v2.5.0...v2.5.1) (2026-08-02)


### Bug Fixes

* **ui:** charge a saved card by id, passed in rather than discovered ([0522cc5](https://github.com/arnaudjnn/billing-tools/commit/0522cc52b7d9204823428419075fbcd7887cb788))

# [2.5.0](https://github.com/arnaudjnn/billing-tools/compare/v2.4.2...v2.5.0) (2026-08-02)


### Features

* **ui:** a checkout session offers the card already on file ([ea4e11a](https://github.com/arnaudjnn/billing-tools/commit/ea4e11a37224cc900159de06df3cecc86998dd05))

## [2.4.2](https://github.com/arnaudjnn/billing-tools/compare/v2.4.1...v2.4.2) (2026-08-02)


### Bug Fixes

* **billing:** a saved card must actually be OFFERED at an embedded top-up ([fe7f8e1](https://github.com/arnaudjnn/billing-tools/commit/fe7f8e11c4bbb3b6ab551fa5c854d591d2f5277a))

## [2.4.1](https://github.com/arnaudjnn/billing-tools/compare/v2.4.0...v2.4.1) (2026-08-02)


### Bug Fixes

* **billing:** an embedded top-up offers the cards the customer already has ([463d63b](https://github.com/arnaudjnn/billing-tools/commit/463d63b0f2814f53755c270f3bbc7b6dff883ecd))

# [2.4.0](https://github.com/arnaudjnn/billing-tools/compare/v2.3.1...v2.4.0) (2026-08-02)


### Features

* **billing:** a top-up can render its payment form in the app ([8c8ed9d](https://github.com/arnaudjnn/billing-tools/commit/8c8ed9d2b7002efdf87e08ad07ec5f349cab04a2))

## [2.3.1](https://github.com/arnaudjnn/billing-tools/compare/v2.3.0...v2.3.1) (2026-08-02)


### Bug Fixes

* **billing:** an untouched wallet is 0 credits, not -0 ([62dacd3](https://github.com/arnaudjnn/billing-tools/commit/62dacd32973817b8fb6acefab8b0a2dc1789954c))

# [2.3.0](https://github.com/arnaudjnn/billing-tools/compare/v2.2.0...v2.3.0) (2026-08-02)


### Features

* **billing:** quote a credit purchase before charging it ([9c89393](https://github.com/arnaudjnn/billing-tools/commit/9c893931d6f8e16b819a7efa781ad6146884b401))

# [2.2.0](https://github.com/arnaudjnn/billing-tools/compare/v2.1.0...v2.2.0) (2026-08-02)


### Features

* **plans:** a rate limit can name the kind of caller it governs ([ef536bb](https://github.com/arnaudjnn/billing-tools/commit/ef536bb490155572e77ae20b430e5e1bb0ae1611))

# [2.1.0](https://github.com/arnaudjnn/billing-tools/compare/v2.0.0...v2.1.0) (2026-08-02)


### Features

* **plans:** an included window can cover people only, so agents are pay-as-you-go ([33f044e](https://github.com/arnaudjnn/billing-tools/commit/33f044e7e173882d015b2ccaf4918048e873866a))

# [2.0.0](https://github.com/arnaudjnn/billing-tools/compare/v1.0.0...v2.0.0) (2026-08-02)


* feat!: one cycle key, no legacy fallback ([76125f4](https://github.com/arnaudjnn/billing-tools/commit/76125f47ab0eab24c1f81f8d86f709cffd26b09c))


### BREAKING CHANGES

* `legacyCycleKey` is no longer exported, and
`extraAllowance(adapter, orgId, memberId, cycle)` takes four arguments.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [1.0.0](https://github.com/arnaudjnn/billing-tools/compare/v0.71.0...v1.0.0) (2026-08-02)


* feat!: the billing unit is a credit, not a token ([0840ece](https://github.com/arnaudjnn/billing-tools/commit/0840ecee10f82bdc52c4d1c29700410117181f03))


### BREAKING CHANGES

* no aliases, in either direction. The TS API, the plan config,
the MCP/REST tool names and the JSON response fields all move at once. A
consumer updates its call sites and its plan config; an agent updates the two
tool names. Keeping both spellings alive was the alternative, and a taxonomy
with two spellings is the thing this commit exists to remove.

The one deliberate survivor is a READ: `session.metadata.credits ||
session.metadata.tokens` in the checkout handlers. A Checkout Session opened
before the deploy still carries the old key, and reading only the new one
would grant 0 credits on a purchase the customer had already paid for. It can
go once no pre-rename session is in flight.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [0.71.0](https://github.com/arnaudjnn/billing-tools/compare/v0.70.2...v0.71.0) (2026-08-02)


### Features

* **plans:** a cap can be measured per MONTH on an annually-billed plan ([154ccbb](https://github.com/arnaudjnn/billing-tools/commit/154ccbbb51aab368ef387735b7a12a9425553706))

## [0.70.2](https://github.com/arnaudjnn/billing-tools/compare/v0.70.1...v0.70.2) (2026-08-02)


### Bug Fixes

* **payments:** card and wallets only, not whatever the Dashboard has enabled ([de26988](https://github.com/arnaudjnn/billing-tools/commit/de269886ceaa4ffc4544646536253989d973e4e4))

## [0.70.1](https://github.com/arnaudjnn/billing-tools/compare/v0.70.0...v0.70.1) (2026-08-02)


### Performance Improvements

* **ui:** mount the checkout on a session PROMISE, and let Stripe draw the wait ([555f293](https://github.com/arnaudjnn/billing-tools/commit/555f29327b0d7a7962a3b782d760c6540967cb00))

# [0.70.0](https://github.com/arnaudjnn/billing-tools/compare/v0.69.0...v0.70.0) (2026-08-02)


### Features

* **payments:** card + Apple Pay + Google Pay, no Link, by default ([c75a135](https://github.com/arnaudjnn/billing-tools/commit/c75a135d90cb1a729b7b234a55a7bc1111d66ddf))

# [0.69.0](https://github.com/arnaudjnn/billing-tools/compare/v0.68.0...v0.69.0) (2026-08-02)


### Features

* **ui:** prefill the whole billing address at checkout, not just the country ([60d52ef](https://github.com/arnaudjnn/billing-tools/commit/60d52efc84d1ebb1694e28bce000c1bb3c60a66d))

# [0.68.0](https://github.com/arnaudjnn/billing-tools/compare/v0.67.0...v0.68.0) (2026-08-02)


### Features

* **ui:** prefill the card form's billing address from the org's profile ([96f6c44](https://github.com/arnaudjnn/billing-tools/commit/96f6c447443a35db6577c54747b74edb341d0c30))

# [0.67.0](https://github.com/arnaudjnn/billing-tools/compare/v0.66.1...v0.67.0) (2026-08-02)


### Features

* **ui:** card form reports WHAT it confirmed, and puts the card above the address ([0f28321](https://github.com/arnaudjnn/billing-tools/commit/0f28321f56398e9a81ed50fd11de468cf7639406))

## [0.66.1](https://github.com/arnaudjnn/billing-tools/compare/v0.66.0...v0.66.1) (2026-08-02)


### Bug Fixes

* **ui:** card-only forms render as a form, not as a one-item accordion ([cec6e8c](https://github.com/arnaudjnn/billing-tools/commit/cec6e8cae9bd53683d97399240c1db0ad51a6b57))

# [0.66.0](https://github.com/arnaudjnn/billing-tools/compare/v0.65.0...v0.66.0) (2026-08-02)


### Features

* **payments:** provision the payment-method configuration, so Link can be turned off ([06d3d5f](https://github.com/arnaudjnn/billing-tools/commit/06d3d5fe4ea63089be88c9f14ddd4f00dccfb41b))

# [0.65.0](https://github.com/arnaudjnn/billing-tools/compare/v0.64.3...v0.65.0) (2026-08-02)


### Features

* **subscription:** previewPlanChange says WHEN the deferred difference lands ([f8c4b43](https://github.com/arnaudjnn/billing-tools/commit/f8c4b43b0f1acdeec3a38c71ae4c78ffcdf5b0f2))

## [0.64.3](https://github.com/arnaudjnn/billing-tools/compare/v0.64.2...v0.64.3) (2026-08-01)


### Bug Fixes

* **topup:** grant_top_up is an admin action, and reachable from the CLI ([eaf31af](https://github.com/arnaudjnn/billing-tools/commit/eaf31af5c80ed34da0235e8b8ef1c4bf6d54202c))

## [0.64.2](https://github.com/arnaudjnn/billing-tools/compare/v0.64.1...v0.64.2) (2026-08-01)


### Bug Fixes

* **create-billing:** forward the options the one-call path was dropping ([07196f2](https://github.com/arnaudjnn/billing-tools/commit/07196f2f2ee073ca2428ea821c1dd7f9df82b74c))

## [0.64.1](https://github.com/arnaudjnn/billing-tools/compare/v0.64.0...v0.64.1) (2026-08-01)


### Bug Fixes

* **billing:** two defects only a real Stripe run could find ([b5a4b04](https://github.com/arnaudjnn/billing-tools/commit/b5a4b04ea2aecbe40ce43579c861f1a2f9e1144a))

# [0.64.0](https://github.com/arnaudjnn/billing-tools/compare/v0.63.3...v0.64.0) (2026-08-01)


### Bug Fixes

* **billing:** the four money defects the QA pass found ([33e256f](https://github.com/arnaudjnn/billing-tools/commit/33e256f393ce1842a0a250dbfab85918e6b8ed6e))


### Features

* **auth:** a caller can identify itself, and admin tools check the role ([9257919](https://github.com/arnaudjnn/billing-tools/commit/9257919509d463512d272624446c42a639f7d2c5))
* **tools:** everything the billing UI can do is now a tool, and the CLI has it too ([0813436](https://github.com/arnaudjnn/billing-tools/commit/08134366cb9b719071d6bae2fd3405c62e532cc4))
* **topup:** let an admin grant extra allowance instead of waiting to be asked ([99ed7ae](https://github.com/arnaudjnn/billing-tools/commit/99ed7ae75b20cdc57124c8d631ad656847418089))

## [0.63.3](https://github.com/arnaudjnn/billing-tools/compare/v0.63.2...v0.63.3) (2026-08-01)


### Bug Fixes

* **i18n:** the payment form still spoke Italian ([1d4376b](https://github.com/arnaudjnn/billing-tools/commit/1d4376b047e890ede61695e1fed6317c7091d980))

## [0.63.2](https://github.com/arnaudjnn/billing-tools/compare/v0.63.1...v0.63.2) (2026-08-01)


### Bug Fixes

* **limits:** the calendar-month fallback knows when it ends, so say so ([678c9e5](https://github.com/arnaudjnn/billing-tools/commit/678c9e595ef3f0373af2dc2344e7a6848ddad0cb))

## [0.63.1](https://github.com/arnaudjnn/billing-tools/compare/v0.63.0...v0.63.1) (2026-08-01)


### Bug Fixes

* **usage:** attribute per-member usage on a pooled plan too ([89c1967](https://github.com/arnaudjnn/billing-tools/commit/89c19679d5df51bca93930879555ccc02f8d38e5))

# [0.63.0](https://github.com/arnaudjnn/billing-tools/compare/v0.62.2...v0.63.0) (2026-08-01)


### Features

* **i18n:** localizable config text, English defaults in the library ([fd8ec5a](https://github.com/arnaudjnn/billing-tools/commit/fd8ec5a677a1f7bbf24aabf36257cc4aa64d7414))

## [0.62.2](https://github.com/arnaudjnn/billing-tools/compare/v0.62.1...v0.62.2) (2026-08-01)


### Bug Fixes

* **limits:** only compare limits that can refuse the same caller ([fa8af4c](https://github.com/arnaudjnn/billing-tools/commit/fa8af4ccd4eb707f2724da9a6f370a5016a9aaeb))

## [0.62.1](https://github.com/arnaudjnn/billing-tools/compare/v0.62.0...v0.62.1) (2026-08-01)


### Bug Fixes

* **create-billing:** let the one-call composition choose where usage is counted ([2da0230](https://github.com/arnaudjnn/billing-tools/commit/2da02309405f0725c9c9adea5b10fdc6c33f32f6))

# [0.62.0](https://github.com/arnaudjnn/billing-tools/compare/v0.61.0...v0.62.0) (2026-08-01)


### Features

* **limits:** usage ceilings per hour, day, week and month, and a read side for them ([071cb90](https://github.com/arnaudjnn/billing-tools/commit/071cb90d84071b6f0faa0460dcf5cfdfdad96e84))

# [0.61.0](https://github.com/arnaudjnn/billing-tools/compare/v0.60.0...v0.61.0) (2026-08-01)


### Features

* **pricing:** the comparison table in config, keyed by plan and derivable ([6b97c12](https://github.com/arnaudjnn/billing-tools/commit/6b97c120dae5cadc3b5ff6e075265fd7473e9a4a))

# [0.60.0](https://github.com/arnaudjnn/billing-tools/compare/v0.59.0...v0.60.0) (2026-08-01)


### Features

* **invoices:** view and download one invoice, and an open one shows what it owes ([25956bc](https://github.com/arnaudjnn/billing-tools/commit/25956bc3aa4ea9bf1125e13315401229be3ffbd4))

# [0.59.0](https://github.com/arnaudjnn/billing-tools/compare/v0.58.1...v0.59.0) (2026-08-01)


### Features

* **subscription:** changePlan — one entry point for up, down and off ([ab97eea](https://github.com/arnaudjnn/billing-tools/commit/ab97eea27a788e46aaeaf3c952b47827e886af64))

## [0.58.1](https://github.com/arnaudjnn/billing-tools/compare/v0.58.0...v0.58.1) (2026-08-01)


### Bug Fixes

* **address:** prefill the name, or Save can never enable ([8014af0](https://github.com/arnaudjnn/billing-tools/commit/8014af0f14a0ed9ceb6daed49c8329250fa398a3))

# [0.58.0](https://github.com/arnaudjnn/billing-tools/compare/v0.57.0...v0.58.0) (2026-08-01)


### Features

* **plans:** accept either plan shape everywhere, and report the real one ([9fb78ad](https://github.com/arnaudjnn/billing-tools/commit/9fb78adf2acdf531ffd3dbdcad33e3e0259dea49))

# [0.57.0](https://github.com/arnaudjnn/billing-tools/compare/v0.56.0...v0.57.0) (2026-08-01)


### Features

* **plans:** plan shapes as config, and included allowance as a window ([fb71aa5](https://github.com/arnaudjnn/billing-tools/commit/fb71aa582b5f4c46e889e2eeeb7b87c2778cb2ae))

# [0.56.0](https://github.com/arnaudjnn/billing-tools/compare/v0.55.0...v0.56.0) (2026-08-01)


### Features

* **tax-ids:** the tax id printed on a customer's invoices ([fafe02b](https://github.com/arnaudjnn/billing-tools/commit/fafe02bbc8249427704fe7cb0b8b95508fe9415c))

# [0.55.0](https://github.com/arnaudjnn/billing-tools/compare/v0.54.0...v0.55.0) (2026-08-01)


### Features

* **config:** defaultLocale for new customers' invoices ([9ca5d58](https://github.com/arnaudjnn/billing-tools/commit/9ca5d583cf5cfca7b29507f0cd26fd8fe6f894b6))

# [0.54.0](https://github.com/arnaudjnn/billing-tools/compare/v0.53.1...v0.54.0) (2026-08-01)


### Features

* **billing-profile:** invoice language ([2c72e19](https://github.com/arnaudjnn/billing-tools/commit/2c72e190dc0e83d3b5b3f7ac36f50985896652bb))

## [0.53.1](https://github.com/arnaudjnn/billing-tools/compare/v0.53.0...v0.53.1) (2026-08-01)


### Bug Fixes

* **address:** pass inert as a boolean ([e8da4c5](https://github.com/arnaudjnn/billing-tools/commit/e8da4c54b0dbf9f91f18446b580b8505d3ca1223))

# [0.53.0](https://github.com/arnaudjnn/billing-tools/compare/v0.52.0...v0.53.0) (2026-08-01)


### Features

* **billing:** currency-correct balances and a subscription price migration ([2379561](https://github.com/arnaudjnn/billing-tools/commit/23795615d0ce673f9052ae7f9a9df9314f2881aa))

# [0.52.0](https://github.com/arnaudjnn/billing-tools/compare/v0.51.0...v0.52.0) (2026-08-01)


### Features

* **address:** free autocomplete without a Google Maps key ([c9a3961](https://github.com/arnaudjnn/billing-tools/commit/c9a3961bdcd938bf9fe4ffd22a014c625d019869))

# [0.51.0](https://github.com/arnaudjnn/billing-tools/compare/v0.50.0...v0.51.0) (2026-08-01)


### Features

* **adapter:** expose subscription state on the seam ([78de890](https://github.com/arnaudjnn/billing-tools/commit/78de890593a4c6d66dbc6b52a45bb092c0153eb9))

# [0.50.0](https://github.com/arnaudjnn/billing-tools/compare/v0.49.1...v0.50.0) (2026-08-01)


### Features

* **billing-profile:** billing address, with Stripe's Address Element ([63777cc](https://github.com/arnaudjnn/billing-tools/commit/63777cc005877e5b3fee39c971829a13ed64a35c))

## [0.49.1](https://github.com/arnaudjnn/billing-tools/compare/v0.49.0...v0.49.1) (2026-08-01)


### Bug Fixes

* **ui:** expose field limits without dragging the server entry into the browser ([3e72308](https://github.com/arnaudjnn/billing-tools/commit/3e72308e18e94380a10a49985181440379a38cd3))

# [0.49.0](https://github.com/arnaudjnn/billing-tools/compare/v0.48.0...v0.49.0) (2026-08-01)


### Bug Fixes

* **billing-profile:** clear Stripe fields with an empty string, not null ([14fbe12](https://github.com/arnaudjnn/billing-tools/commit/14fbe125792835cef5ea17041dd7a3a9b1a016a0))


### Features

* **billing-profile:** invoice recipient and company name ([daa1eb9](https://github.com/arnaudjnn/billing-tools/commit/daa1eb910565b44d12499eb33bbe649c07f446e8))
* **workos:** export getWorkOS and the Pattern B org mirror ([f0f9e30](https://github.com/arnaudjnn/billing-tools/commit/f0f9e30dc8ce62fb43dfe60f0082c02677bc9349))

# [0.48.0](https://github.com/arnaudjnn/billing-tools/compare/v0.47.0...v0.48.0) (2026-08-01)


### Features

* **payment-methods:** manage saved cards without the Stripe portal ([677b204](https://github.com/arnaudjnn/billing-tools/commit/677b20449f7190c4977a0a169fbac7d8a1ef78a6))

# [0.47.0](https://github.com/arnaudjnn/billing-tools/compare/v0.46.1...v0.47.0) (2026-08-01)


### Features

* **checkout:** reuse the session already open for a basket ([293e7c5](https://github.com/arnaudjnn/billing-tools/commit/293e7c5b13f5381b3ac34ea9fc3e10efed17a4fd))

## [0.46.1](https://github.com/arnaudjnn/billing-tools/compare/v0.46.0...v0.46.1) (2026-08-01)


### Performance Improvements

* **billing:** stop re-reading what never changes on the checkout path ([6ddaf7e](https://github.com/arnaudjnn/billing-tools/commit/6ddaf7e447cf8544138c8b1f1b636794e7b07377))

# [0.46.0](https://github.com/arnaudjnn/billing-tools/compare/v0.45.0...v0.46.0) (2026-08-01)


### Bug Fixes

* **ui:** stop useCheckoutTax looping on the session snapshot ([493364e](https://github.com/arnaudjnn/billing-tools/commit/493364ea05114d095433139c34e43f15e6f42ece))


### Features

* **ui:** AuthKitSessionProvider — make useSession() answer on static pages too ([e6bc25c](https://github.com/arnaudjnn/billing-tools/commit/e6bc25c627909b86dc9366cba9f2d4f4831c6f84))
* **ui:** expose loading on the session ([99755a1](https://github.com/arnaudjnn/billing-tools/commit/99755a11f5987c76e3296afdec0db02812e98e5e))

# [0.45.0](https://github.com/arnaudjnn/billing-tools/compare/v0.44.0...v0.45.0) (2026-08-01)


### Features

* **checkout:** open the payment form without the wait ([c7c047d](https://github.com/arnaudjnn/billing-tools/commit/c7c047dc7871e26c2f01bfede66ba674be2c0a0a))
* **ui:** default useCheckoutTax's tax number to the one on the session ([e9237eb](https://github.com/arnaudjnn/billing-tools/commit/e9237ebf21f86bfcb574c3323d3abae86afc958c))

# [0.43.0](https://github.com/arnaudjnn/billing-tools/compare/v0.42.0...v0.43.0) (2026-08-01)


### Features

* **session:** one DB-free useSession() for user, org role and plan ([0458283](https://github.com/arnaudjnn/billing-tools/commit/0458283e24b2fd6d6ce90c92fa2930c67786593d))

# [0.42.0](https://github.com/arnaudjnn/billing-tools/compare/v0.41.0...v0.42.0) (2026-07-31)


### Features

* **tax:** compute tax locally with sales-tax instead of paying Stripe Tax ([7540301](https://github.com/arnaudjnn/billing-tools/commit/75403012c19dbb598d56283b644a24650a5e8364))

# [0.41.0](https://github.com/arnaudjnn/billing-tools/compare/v0.40.1...v0.41.0) (2026-07-31)


### Features

* ensureTaxSetup — Stripe Tax configuration as code ([7ecaf99](https://github.com/arnaudjnn/billing-tools/commit/7ecaf9906e70344901b5d5d0672ec91521e50317))

## [0.40.1](https://github.com/arnaudjnn/billing-tools/compare/v0.40.0...v0.40.1) (2026-07-31)


### Bug Fixes

* **webhook:** forward subscription checkouts; expose session metadata ([1815d0b](https://github.com/arnaudjnn/billing-tools/commit/1815d0bbacbcb9421f3ec7dd177355173fa6cd9c))

# [0.40.0](https://github.com/arnaudjnn/billing-tools/compare/v0.39.0...v0.40.0) (2026-07-31)


### Features

* **dev:** one command to receive webhooks locally — CLI included ([3c983a5](https://github.com/arnaudjnn/billing-tools/commit/3c983a52e72b0cbb4e782480541424025d8beee0))

# [0.39.0](https://github.com/arnaudjnn/billing-tools/compare/v0.38.0...v0.39.0) (2026-07-31)


### Features

* checkBillingSetup — preflight for the failures that stay silent ([e7d0fcd](https://github.com/arnaudjnn/billing-tools/commit/e7d0fcd62d25768a83cd4812f45790b882d6245c))

# [0.38.0](https://github.com/arnaudjnn/billing-tools/compare/v0.37.0...v0.38.0) (2026-07-31)


### Features

* **create-billing:** forward webhook options, notably onOtherEvent ([2274ca8](https://github.com/arnaudjnn/billing-tools/commit/2274ca843e46014fb76c51d21cc90f44d57db756))

# [0.37.0](https://github.com/arnaudjnn/billing-tools/compare/v0.36.3...v0.37.0) (2026-07-31)


### Features

* payments on the webhook, state on the poller ([9225f4f](https://github.com/arnaudjnn/billing-tools/commit/9225f4f02e210afda87aa99ff4e15f3dad5a6f6b))

## [0.36.3](https://github.com/arnaudjnn/billing-tools/compare/v0.36.2...v0.36.3) (2026-07-31)


### Bug Fixes

* **events:** stop dropping events when the backlog exceeds the poll cap ([a48ad85](https://github.com/arnaudjnn/billing-tools/commit/a48ad853d2dba17052a6b466b25ab02a2f9075e1))

## [0.36.2](https://github.com/arnaudjnn/billing-tools/compare/v0.36.1...v0.36.2) (2026-07-31)


### Bug Fixes

* **webhook:** say "not configured" instead of "signature verification failed" ([41e1865](https://github.com/arnaudjnn/billing-tools/commit/41e1865defd3d1f9eaa6ed580aa2f5b550764c9b))

## [0.36.1](https://github.com/arnaudjnn/billing-tools/compare/v0.36.0...v0.36.1) (2026-07-31)


### Bug Fixes

* **webhook-setup:** union events by default, and surface duplicate endpoints ([6575e28](https://github.com/arnaudjnn/billing-tools/commit/6575e281269b9dab273dc1253820f2b6936fee25))

# [0.36.0](https://github.com/arnaudjnn/billing-tools/compare/v0.35.0...v0.36.0) (2026-07-31)


### Features

* make the webhook optional, and registrable from code ([39174c0](https://github.com/arnaudjnn/billing-tools/commit/39174c098175384a7f5dbe2c2ee5fa189c8c78f8))

# [0.35.0](https://github.com/arnaudjnn/billing-tools/compare/v0.34.0...v0.35.0) (2026-07-30)


### Features

* **ui:** defaultCountry on the session provider ([b58740a](https://github.com/arnaudjnn/billing-tools/commit/b58740aa3aaeb4dd52dc33ae7e42c0481ddc20d3))

# [0.34.0](https://github.com/arnaudjnn/billing-tools/compare/v0.33.0...v0.34.0) (2026-07-30)


### Features

* **ui:** collect a tax ID without Stripe's preview element ([6910a4c](https://github.com/arnaudjnn/billing-tools/commit/6910a4c2d089bb890a46b36cc2321f9dcac38ec9))

# [0.33.0](https://github.com/arnaudjnn/billing-tools/compare/v0.32.1...v0.33.0) (2026-07-30)


### Features

* **ui:** don't offer Link by default in the session form ([60a5e52](https://github.com/arnaudjnn/billing-tools/commit/60a5e52d1f92abcd1b3d6d86511d20d04f3e5a34))

## [0.32.1](https://github.com/arnaudjnn/billing-tools/compare/v0.32.0...v0.32.1) (2026-07-30)


### Bug Fixes

* **ui:** skip the Tax ID Element when the account lacks the preview ([bc3d82f](https://github.com/arnaudjnn/billing-tools/commit/bc3d82f3e2bf646526036a4dfee5b1352aeee8bf))

# [0.32.0](https://github.com/arnaudjnn/billing-tools/compare/v0.31.0...v0.32.0) (2026-07-30)


### Features

* **checkout:** Stripe Tax by default via Checkout Sessions ([e4e4234](https://github.com/arnaudjnn/billing-tools/commit/e4e4234fafbf2d267a9cc3ed2b605d536384271c))

# [0.31.0](https://github.com/arnaudjnn/billing-tools/compare/v0.30.0...v0.31.0) (2026-07-30)


### Features

* **ui:** Tax ID Element support (opt-in, public preview) ([5679f4c](https://github.com/arnaudjnn/billing-tools/commit/5679f4ca927ebbb2a4da80b46c024332796c3d7a))

# [0.30.0](https://github.com/arnaudjnn/billing-tools/compare/v0.29.0...v0.30.0) (2026-07-30)


### Features

* **checkout:** card-only by default; opt in to other payment methods ([865a4b5](https://github.com/arnaudjnn/billing-tools/commit/865a4b56084884d2b40f14459548c51863b55d94))

# [0.29.0](https://github.com/arnaudjnn/billing-tools/compare/v0.28.0...v0.29.0) (2026-07-30)


### Features

* **ui:** useCheckout hook + drop "seat" from the checkout API ([de38a23](https://github.com/arnaudjnn/billing-tools/commit/de38a23a3355db0db358a1cd68222076347246a1))

# [0.28.0](https://github.com/arnaudjnn/billing-tools/compare/v0.27.0...v0.28.0) (2026-07-30)


### Features

* **checkout:** updateSeatSubscription + cancelSeatSubscription ([3a4a4fa](https://github.com/arnaudjnn/billing-tools/commit/3a4a4fa8ad34b59d0c9fb3a80d172706ef041539))

# [0.27.0](https://github.com/arnaudjnn/billing-tools/compare/v0.26.2...v0.27.0) (2026-07-30)


### Features

* **checkout:** fixed-rate VAT option, since automatic_tax needs an address first ([2827786](https://github.com/arnaudjnn/billing-tools/commit/2827786897498b647824cc6fb45c1138840ae090))

## [0.26.2](https://github.com/arnaudjnn/billing-tools/compare/v0.26.1...v0.26.2) (2026-07-30)


### Bug Fixes

* **plans:** don't reuse a matching price whose product is archived ([d5bcb22](https://github.com/arnaudjnn/billing-tools/commit/d5bcb22671589316f4f4bde8fc53a833e6d70392))

## [0.26.1](https://github.com/arnaudjnn/billing-tools/compare/v0.26.0...v0.26.1) (2026-07-30)


### Bug Fixes

* **plans:** never resolve or reuse a price on an archived product ([bf88868](https://github.com/arnaudjnn/billing-tools/commit/bf8886820db164a5bef301fc9b8392a55d584d61))

# [0.26.0](https://github.com/arnaudjnn/billing-tools/compare/v0.25.0...v0.26.0) (2026-07-30)


### Features

* **checkout:** createSeatSubscription + address collection in /ui ([159f8e0](https://github.com/arnaudjnn/billing-tools/commit/159f8e0db2fb72a795be918ba95de876754e2bf1))

# [0.25.0](https://github.com/arnaudjnn/billing-tools/compare/v0.24.0...v0.25.0) (2026-07-30)


### Features

* **ui:** ship the Stripe browser SDKs as deps so consumers don't install Stripe ([49ed663](https://github.com/arnaudjnn/billing-tools/commit/49ed66315fd8b80fdbe29654576c13eea073f88c))

# [0.24.0](https://github.com/arnaudjnn/billing-tools/compare/v0.23.0...v0.24.0) (2026-07-30)


### Features

* **ui:** checkout components on a /ui entry point ([6c2a36a](https://github.com/arnaudjnn/billing-tools/commit/6c2a36ab2be59011426a562bfacafaaa2fa24439))

# [0.23.0](https://github.com/arnaudjnn/billing-tools/compare/v0.22.0...v0.23.0) (2026-07-30)


### Features

* **cli:** add lightweight ./cli subpath export ([10657a5](https://github.com/arnaudjnn/billing-tools/commit/10657a52703a3f018d1ade89361a68c3a644fd45))

# [0.22.0](https://github.com/arnaudjnn/billing-tools/compare/v0.21.0...v0.22.0) (2026-07-30)


### Features

* **adapters:** surface createdAt/lastUsedAt/permissions on listApiKeys ([bd65976](https://github.com/arnaudjnn/billing-tools/commit/bd65976e5bcf3ef49ffc4779daca71f5add8083b))

# [0.21.0](https://github.com/arnaudjnn/billing-tools/compare/v0.20.0...v0.21.0) (2026-07-30)


### Features

* **cli:** usage/seats/assign-seat + topup subcommands in registerBillingCommands ([67d5d10](https://github.com/arnaudjnn/billing-tools/commit/67d5d107a98385a64b2e5a0673017d9176bdf69c))

# [0.20.0](https://github.com/arnaudjnn/billing-tools/compare/v0.19.0...v0.20.0) (2026-07-30)


### Features

* **tools:** workspace-management tools — usage, seats, top-up requests ([d87a15f](https://github.com/arnaudjnn/billing-tools/commit/d87a15f395383bccada3b60caa007fab5eca8145))

# [0.19.0](https://github.com/arnaudjnn/billing-tools/compare/v0.18.0...v0.19.0) (2026-07-30)


### Features

* **create-billing:** billing.meter + billing.meterRequest from one config ([257585a](https://github.com/arnaudjnn/billing-tools/commit/257585a8805ca82baaab37b0c8e1bee9c751d1e0))

# [0.18.0](https://github.com/arnaudjnn/billing-tools/compare/v0.17.0...v0.18.0) (2026-07-30)


### Features

* **metering:** createMeter — the bound call-site meter, so consumers stop duplicating glue ([d14f02a](https://github.com/arnaudjnn/billing-tools/commit/d14f02a3cba8d8dba3e5de4c4df72f5d0d0ada0f))

# [0.17.0](https://github.com/arnaudjnn/billing-tools/compare/v0.16.0...v0.17.0) (2026-07-29)


### Features

* **metering:** shared per-execution metering engine (prepaid, no new backend) ([a94c295](https://github.com/arnaudjnn/billing-tools/commit/a94c295f1c5f9449ba8d8e94775ff81f6196fe52))
* **plans:** optional seat types (per-type price + included tokens) ([eb1af97](https://github.com/arnaudjnn/billing-tools/commit/eb1af9720c06db7a474c4f244aaab589033ec35a))
* **plans:** ship DEFAULT_SEAT_TYPES (USD) as the library defaults ([a47caff](https://github.com/arnaudjnn/billing-tools/commit/a47caffe55f7cb43ceb60f781b4b9bee9f7caeaf))
* **topup:** user-seat top-up requests + admin-gated auto-top-up (WorkOS metadata) ([f318cb2](https://github.com/arnaudjnn/billing-tools/commit/f318cb2e38cbd7a4e89d587d81435c9c667ae818))

# [0.16.0](https://github.com/arnaudjnn/billing-tools/compare/v0.15.0...v0.16.0) (2026-07-29)


### Features

* **oauth-proxy:** MCP OAuth 2.1 + dynamic client registration ([3c342ff](https://github.com/arnaudjnn/billing-tools/commit/3c342ff01bbf21f2db54f4dcaebfddf9aa3ab504))

# [0.15.0](https://github.com/arnaudjnn/billing-tools/compare/v0.14.0...v0.15.0) (2026-07-25)


### Features

* wire machine payments (MPP) into createBilling() ([9f498ae](https://github.com/arnaudjnn/billing-tools/commit/9f498ae8076ab1ce5223186b5b8ec5e3b55fcd19))
