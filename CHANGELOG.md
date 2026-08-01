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
