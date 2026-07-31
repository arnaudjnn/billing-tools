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
