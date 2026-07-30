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
