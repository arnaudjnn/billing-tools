// Tax-ID types Stripe accepts on a customer.
//
// GENERATED from the Stripe SDK's `Stripe.TaxId.Type` union — the same enum the
// API validates against — so it can't drift from what a create call will
// accept. Regenerate by re-reading `stripe/types/TaxIds.d.ts` when the SDK is
// upgraded.
//
// A leaf module with no imports, like the field limits and locales next door: a
// picker is a client component, and reaching for this through the package root
// would drag the server entry into the browser bundle.
//
// No labels here either, and for the same reason as the languages: every code
// is `<region>_<kind>`, so a display name is derivable — `Intl.DisplayNames`
// for the region, the kind uppercased — in the consuming app's own language. A
// table of 112 English names would be worse and would go stale.
export const TAX_ID_TYPES = [
  "ad_nrt",
  "ae_trn",
  "al_tin",
  "am_tin",
  "ao_tin",
  "ar_cuit",
  "au_abn",
  "au_arn",
  "aw_tin",
  "az_tin",
  "ba_tin",
  "bb_tin",
  "bd_bin",
  "bf_ifu",
  "bg_uic",
  "bh_vat",
  "bj_ifu",
  "bo_tin",
  "br_cnpj",
  "br_cpf",
  "bs_tin",
  "by_tin",
  "ca_bn",
  "ca_gst_hst",
  "ca_pst_bc",
  "ca_pst_mb",
  "ca_pst_sk",
  "ca_qst",
  "cd_nif",
  "ch_uid",
  "ch_vat",
  "cl_tin",
  "cm_niu",
  "cn_tin",
  "co_nit",
  "cr_tin",
  "cv_nif",
  "de_stn",
  "do_rcn",
  "ec_ruc",
  "eg_tin",
  "es_cif",
  "et_tin",
  "eu_oss_vat",
  "eu_vat",
  "gb_vat",
  "ge_vat",
  "gn_nif",
  "hk_br",
  "hr_oib",
  "hu_tin",
  "id_npwp",
  "il_vat",
  "in_gst",
  "is_vat",
  "jp_cn",
  "jp_rn",
  "jp_trn",
  "ke_pin",
  "kg_tin",
  "kh_tin",
  "kr_brn",
  "kz_bin",
  "la_tin",
  "li_uid",
  "li_vat",
  "lk_vat",
  "ma_vat",
  "md_vat",
  "me_pib",
  "mk_vat",
  "mr_nif",
  "mx_rfc",
  "my_frp",
  "my_itn",
  "my_sst",
  "ng_tin",
  "no_vat",
  "no_voec",
  "np_pan",
  "nz_gst",
  "om_vat",
  "pe_ruc",
  "ph_tin",
  "pl_nip",
  "ro_tin",
  "rs_pib",
  "ru_inn",
  "ru_kpp",
  "sa_vat",
  "sg_gst",
  "sg_uen",
  "si_tin",
  "sn_ninea",
  "sr_fin",
  "sv_nit",
  "th_vat",
  "tj_tin",
  "tr_tin",
  "tw_vat",
  "tz_vat",
  "ua_vat",
  "ug_tin",
  "unknown",
  "us_ein",
  "uy_ruc",
  "uz_tin",
  "uz_vat",
  "ve_rif",
  "vn_tin",
  "za_vat",
  "zm_tin",
] as const;

export type TaxIdType = (typeof TAX_ID_TYPES)[number];

/**
 * Split a code into its region and kind: `"ca_gst_hst"` → `["ca", "GST/HST"]`.
 *
 * The region is an ISO code (plus `eu` and `xi`, which CLDR also knows), so the
 * caller can name it with `Intl.DisplayNames` in whatever language it renders.
 */
export function splitTaxIdType(code: string): [region: string, kind: string] {
  const [region, ...rest] = code.split("_");
  return [region, rest.join("/").toUpperCase()];
}
