import {
  formatMessage,
  resolveLocalized,
  resolveLocalizedList,
  resolveMessages,
  type LocaleOptions,
  type Localized,
  type Messages,
  type PartialMessages,
} from "./i18n.js";
import {
  defaultBasket,
  normalizePlans,
  poolSizeOf,
  type BillingInterval,
  type Money,
  type PlanCatalog,
  type PlanModel,
  type Sale,
} from "./plan-model.js";

// The plan config, turned into what a pricing surface renders.
//
// Imports `plan-model` and nothing else — no Stripe, no React — so the SAME
// derivation feeds a React card, a server component, and a markdown generator.
// Which is the point: the numbers on a marketing page, on an in-app upgrade
// page, and in a docs table stop being three transcriptions of the config.
//
// It ships no strings. Every word (name, tagline, features, CTA label, badge)
// is authored by the app on the plan itself; this only formats numbers and
// decides shapes. `unit` is a KEY rather than prose for that reason — one
// consumer renders "/month", another "/mo", another in its own language.
//
// What this file exists to prevent, from the app it was extracted from:
//   • an annual saving advertised at 17% next to a checkout charging 14% — two
//     derivations from two different bases, so `annualSavingBasis` now says which
//   • "50 searches a day" against a config of 1000 credits a cycle
//   • "up to 10 members" against a limit of 100
//   • a plan with an org-level allowance that had NO rendering path at all, so
//     its price and package size were invisible on every surface

// Re-exported so `@arnaudjnn/billing-tools/pricing` is self-sufficient: a plans
// config can be authored, normalised and rendered without importing the root
// entry point (which pulls in Stripe and WorkOS).
export {
  definePlans,
  normalizePlan,
  normalizePlans,
  planModel,
  plansWhere,
  selfServePlans,
  defaultBasket,
  validateBasket,
  describeBasketProblem,
  poolSizeOf,
  packSizeOf,
} from "./plan-model.js";
export {
  resolveLocalized,
  resolveLocalizedList,
  resolveMessages,
  formatMessage,
  DEFAULT_MESSAGES,
} from "./i18n.js";
export type {
  Localized,
  LocalizedList,
  LocaleOptions,
  Messages,
  PartialMessages,
} from "./i18n.js";
export type {
  BillingInterval,
  Money,
  IntervalPrice,
  PlanCatalog,
  PlanDef,
  PlanSpec,
  PlanModel,
  PlanDisplay,
  SeatTypeSpec,
  SeatTypeDisplay,
  Sells,
  Grant,
  Cap,
  CapWindow,
  CapCovers,
  Replenish,
  Sale,
  Quantities,
  BasketProblem,
} from "./plan-model.js";

export interface MoneyView {
  /** Minor units, for arithmetic. */
  minor: Money;
  /** Formatted for display. */
  text: string;
}

export interface SeatRowView {
  key: string;
  label: string;
  usage: string | null;
  /** Drawn by agents/API keys rather than a person — normally not a card row. */
  shared: boolean;
  /** Priced at zero (a free plan's single seat). */
  free: boolean;
  min: number;
  max: number | null;
  /** Per-MONTH figure for each interval (yearly ÷ 12) — how seats are compared. */
  perMonth: Record<BillingInterval, MoneyView>;
  /** What is actually charged for that interval. */
  total: Record<BillingInterval, MoneyView>;
  includedCredits: number;
}

export interface PlanPriceView {
  kind: "free" | "seats" | "flat" | "quote";
  /** Headline for the selected interval. Null when the price is quoted. */
  headline: MoneyView | null;
  /** A key, not prose: the app supplies "/month" or "per seat / month". */
  unit: "month" | "year" | "seat_month" | "seat_year" | null;
  /** The other interval, for a muted "billed annually" line. */
  alternate: { interval: BillingInterval; perMonth: MoneyView; total: MoneyView } | null;
  /**
   * What the DEFAULT basket actually costs, per interval — the charge, not the
   * comparison figure.
   *
   * `headline` is deliberately a per-MONTH number (that is how plans are
   * compared), so a surface that needs the real annual amount has to read it
   * here. Rendering the headline in a "Yearly" column shows a twelfth of the
   * price, which is exactly the mistake this field exists to prevent.
   */
  totals: Record<BillingInterval, MoneyView>;
  rows: readonly SeatRowView[];
  /**
   * The name of the seat a plan that sells NONE gives you (`seat.display.label`),
   * else null.
   *
   * A card still has to label that plan's single seat segment, and with nothing
   * here the app typed the words in — a string that then had to agree with what
   * the meter and the usage screen call the same seat. `rows` stays empty: this
   * seat is not purchasable and must never appear in a basket.
   */
  seatLabel: string | null;
  /** Total seats a basket must stay within, across every type. `minSeats: 2` is
   *  "a team of one is Hobby". Null max = unlimited. A seat stepper needs both,
   *  and deriving them from the rows' own min/max gets the plan-level total
   *  wrong. */
  minSeats: number;
  maxSeats: number | null;
  /** For a plan with no per-seat figure to show (a committed package). */
  pooled: { title: string; note: string | null } | null;
}

export interface CtaView {
  kind: "signup" | "checkout" | "contact" | "current" | "unavailable";
  label: string;
  href: string | null;
  disabledReason: string | null;
}

export interface PlanView {
  key: string;
  name: string;
  tagline: string | null;
  badge: string | null;
  featured: boolean;
  order: number;
  featuresIntro: string | null;
  features: readonly string[];
  price: PlanPriceView;
  cta: CtaView;
  /** Whole percent saved by paying yearly, FLOORED so it never overstates.
   *  Null when the plan has no monthly/yearly pair. */
  annualSaving: number | null;
  /** WHICH basket that percentage came from. Naming it is what stops one surface
   *  advertising a saving another surface doesn't charge. */
  annualSavingBasis: "flat" | "basket" | null;
  members: { max: number | null };
  /** Included usage per cycle for the default basket, and where it pools. */
  included: { credits: number; scope: "per_seat" | "pool" | "none" };
  /** Intervals the plan is actually SOLD on — `["yearly"]` for an annual-only
   *  commitment. Not derivable from the rendered price: a quoted plan shows no
   *  price at all yet still has a billing cycle. */
  intervals: readonly BillingInterval[];
  sale: Sale;
  interval: BillingInterval;}

export interface DerivePlanViewsOptions extends LocaleOptions {
  /** Which interval the headline shows. Default "yearly". */
  interval?: BillingInterval;
  currency?: string;
  /**
   * Override the handful of words the library supplies itself ("Unlimited",
   * "Monthly", "Contact us", the refusal messages). Anything not overridden stays
   * ENGLISH — see DEFAULT_MESSAGES.
   */
  messages?: PartialMessages;
  /** Override the formatter. Intl renders "18,00 €" for de-DE; a house style may
   *  want "€18". */
  formatMoney?: (minor: Money, currency: string, locale: string) => string;
  /** Its card becomes `cta.kind: "current"`. */
  currentPlan?: string | null;
  /** false → every CTA disabled with a reason (e.g. a non-admin viewer). */
  canManage?: boolean | { reason: string };
  hrefs?: {
    signup?: string;
    contact?: string;
    checkout?: (plan: string) => string;
  };
  /** Also include `display.hidden` plans and `sale: "legacy"`. Default false. */
  includeHidden?: boolean;
}

const defaultFormatMoney = (minor: Money, currency: string, locale: string): string => {
  const text = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(minor / 100);
  return text;
};

/** The default basket's cost for an interval, so a headline and a saving are
 *  computed from the same quantities. */
function basketTotal(model: PlanModel, interval: BillingInterval): Money {
  if (model.sells.kind === "flat") return model.sells.price[interval];
  const basket = defaultBasket(model);
  return model.seatTypes.reduce(
    (sum, s) => sum + (basket[s.key] ?? 0) * s.price[interval],
    0,
  );
}

function priceKindOf(model: PlanModel): PlanPriceView["kind"] {
  if (model.sale === "quote") return "quote";
  if (model.sells.kind === "nothing") return "free";
  return model.sells.kind === "seats" ? "seats" : "flat";
}

function ctaFor(
  model: PlanModel,
  opts: DerivePlanViewsOptions,
): CtaView {
  const text = (v: Localized | undefined) => resolveLocalized(v, opts);
  const label = text(model.display?.cta?.label) ?? text(model.display?.name) ?? model.key;
  const manage = opts.canManage ?? true;
  const disabledReason = manage === true ? null : typeof manage === "object" ? manage.reason : "";
  const href = model.display?.cta?.href ?? null;

  if (opts.currentPlan && opts.currentPlan === model.key) {
    return { kind: "current", label, href: null, disabledReason: null };
  }
  if (disabledReason !== null) {
    return { kind: "unavailable", label, href: null, disabledReason };
  }
  switch (model.sale) {
    case "quote":
      return { kind: "contact", label, href: href ?? opts.hrefs?.contact ?? null, disabledReason: null };
    case "free":
      return { kind: "signup", label, href: href ?? opts.hrefs?.signup ?? null, disabledReason: null };
    case "legacy":
      return { kind: "unavailable", label, href: null, disabledReason: "No longer offered" };
    case "self_serve":
      return {
        kind: "checkout",
        label,
        href: href ?? opts.hrefs?.checkout?.(model.key) ?? null,
        disabledReason: null,
      };
  }
}

export function derivePlanViews(
  plans: PlanCatalog,
  opts: DerivePlanViewsOptions = {},
): readonly PlanView[] {
  const interval = opts.interval ?? "yearly";
  const locale = opts.locale ?? "en-US";
  const currency = opts.currency ?? "usd";
  const messages = resolveMessages(opts.messages);
  const text = (v: Localized | undefined) => resolveLocalized(v, opts);
  const fmt = opts.formatMoney ?? defaultFormatMoney;
  const money = (minor: Money): MoneyView => ({ minor, text: fmt(minor, currency, locale) });
  const other: BillingInterval = interval === "yearly" ? "monthly" : "yearly";

  return normalizePlans(plans)
    .filter((m) => opts.includeHidden || (!m.display?.hidden && m.sale !== "legacy"))
    .map((model): PlanView => {
      const rows: SeatRowView[] = model.seatTypes.map((s) => ({
        key: s.key,
        label: text(s.display?.label) ?? s.key,
        usage: text(s.display?.usage) ?? null,
        shared: s.shared,
        free: s.price.monthly === 0 && s.price.yearly === 0,
        min: s.min,
        max: s.max,
        // The annual figure per MONTH, because that is how a seat is compared;
        // `total` keeps what is actually charged.
        perMonth: {
          monthly: money(s.price.monthly),
          yearly: money(Math.round(s.price.yearly / 12)),
        },
        total: { monthly: money(s.price.monthly), yearly: money(s.price.yearly) },
        includedCredits: s.includedCredits,
      }));

      const kind = priceKindOf(model);
      const sells = model.sells;
      const headline =
        kind === "quote"
          ? null
          : kind === "free"
            ? money(0)
            : sells.kind === "flat"
              ? money(interval === "yearly" ? Math.round(sells.price.yearly / 12) : sells.price.monthly)
              : // A seat-typed plan's headline is its cheapest non-shared seat:
                // the "from" figure, per month.
                money(
                  Math.min(
                    ...rows
                      .filter((r) => !r.shared && !r.free)
                      .map((r) => r.perMonth[interval].minor),
                  ) || 0,
                );

      const unit: PlanPriceView["unit"] =
        kind === "quote" || kind === "free"
          ? null
          : sells.kind === "flat"
            ? "month"
            : interval === "yearly"
              ? "seat_month"
              : "seat_month";

      const hasBoth = model.intervals.includes("monthly") && model.intervals.includes("yearly");
      const monthlyTotal = basketTotal(model, "monthly");
      const yearlyTotal = basketTotal(model, "yearly");
      const twelve = monthlyTotal * 12;
      const annualSaving =
        hasBoth && twelve > 0 && yearlyTotal > 0
          ? Math.floor(((twelve - yearlyTotal) / twelve) * 100)
          : null;

      const pool = poolSizeOf(model);
      const basket = defaultBasket(model);
      const includedPerSeat = model.seatTypes.reduce(
        (sum, s) => sum + s.includedCredits * (basket[s.key] ?? 0),
        0,
      );

      return {
        key: model.key,
        name: text(model.display?.name) ?? model.key,
        tagline: text(model.display?.tagline) ?? null,
        badge: text(model.display?.badge) ?? null,
        featured: model.display?.featured ?? false,
        order: model.display?.order ?? Number.MAX_SAFE_INTEGER,
        featuresIntro: text(model.display?.featuresIntro) ?? null,
        features: resolveLocalizedList(model.display?.features, opts),
        price: {
          kind,
          headline,
          unit,
          alternate:
            hasBoth && kind !== "quote" && kind !== "free"
              ? {
                  interval: other,
                  perMonth: money(
                    other === "yearly" ? Math.round(yearlyTotal / 12) : monthlyTotal,
                  ),
                  total: money(other === "yearly" ? yearlyTotal : monthlyTotal),
                }
              : null,
          totals: { monthly: money(monthlyTotal), yearly: money(yearlyTotal) },
          minSeats: sells.kind === "seats" ? (sells.minSeats ?? 0) : 0,
          maxSeats: sells.kind === "seats" ? (sells.maxSeats ?? null) : null,
          rows,
          seatLabel: model.seat ? (text(model.seat.display?.label) ?? model.seat.key) : null,
          pooled: model.display?.pooled
            ? {
                title: text(model.display.pooled.title) ?? "",
                note: text(model.display.pooled.note) ?? null,
              }
            : null,
        },
        cta: ctaFor(model, opts),
        annualSaving,
        annualSavingBasis: annualSaving === null ? null : sells.kind === "flat" ? "flat" : "basket",
        members: { max: model.limits.members },
        included:
          pool !== null
            ? { credits: pool, scope: "pool" }
            : includedPerSeat > 0
              ? { credits: includedPerSeat, scope: "per_seat" }
              : { credits: 0, scope: "none" },
        intervals: model.intervals,
        sale: model.sale,
        interval,
      };
    })
    .sort((a, b) => a.order - b.order);
}

export function derivePlanView(
  plans: PlanCatalog,
  key: string,
  opts: DerivePlanViewsOptions = {},
): PlanView | null {
  return derivePlanViews(plans, { ...opts, includeHidden: true }).find((v) => v.key === key) ?? null;
}

// ── Markdown, for a docs site ───────────────────────────────────────────────
//
// Same view models the React cards use. A hand-written pricing table drifts from
// the config the moment either changes — and it had, in four places at once, in
// two directions.

export interface MarkdownOptions {
  columns?: readonly ("name" | "members" | "included" | "monthly" | "yearly" | "seats")[];
  /** Escape `$` so MDX doesn't read it as an expression. Default true. */
  mdx?: boolean;
  /** Header for the `included` column. Overrides `messages.columnIncluded`. */
  includedLabel?: string;
  /** Column headers and the "Contact us" / "Unlimited" / "Free" cells. English
   *  unless overridden. */
  messages?: PartialMessages;
}

const esc = (s: string, mdx: boolean): string =>
  mdx ? s.replace(/\$/g, "\\$").replace(/\|/g, "\\|") : s.replace(/\|/g, "\\|");

/** A plan table. Quoted plans show "Contact us" rather than a fabricated price. */
export function renderPlansMarkdown(
  views: readonly PlanView[],
  opts: MarkdownOptions = {},
): string {
  const mdx = opts.mdx ?? true;
  const columns = opts.columns ?? ["name", "members", "included", "monthly", "yearly"];
  const m = resolveMessages(opts.messages);
  const head: Record<string, string> = {
    name: m.columnPlan,
    members: m.columnSeats,
    included: opts.includedLabel ?? m.columnIncluded,
    monthly: m.columnMonthly,
    yearly: m.columnYearly,
    seats: m.columnSeatTypes,
  };
  const cell = (v: PlanView, col: string): string => {
    switch (col) {
      case "name":
        return `**${v.name}**`;
      case "members":
        return v.members.max === null ? m.unlimited : String(v.members.max);
      case "included":
        return v.included.credits ? v.included.credits.toLocaleString("en-US") : "—";
      case "monthly":
      case "yearly": {
        if (v.sale === "quote") return m.contactUs;
        const per = col === "monthly" ? "monthly" : "yearly";
        // Per-seat plans quote a seat; everything else quotes what the default
        // basket is CHARGED for that interval (`price.totals`, not the per-month
        // headline).
        const seatRows = v.price.rows.filter((r) => !r.shared && !r.free);
        if (seatRows.length) {
          return seatRows.map((r) => `${r.total[per].text} / seat`).join(" · ");
        }
        return v.price.totals[per].minor > 0 ? v.price.totals[per].text : m.free;
      }
      case "seats":
        return v.price.rows.length
          ? v.price.rows.map((r) => r.label + (r.shared ? " (shared)" : "")).join(", ")
          : "—";
      default:
        return "";
    }
  };
  const lines = [
    `| ${columns.map((c) => head[c]).join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
    ...views.map((v) => `| ${columns.map((c) => esc(cell(v, c), mdx)).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** A cost-per-action table, optionally grouped. Replaces a hand-maintained one. */
export function renderRateCardMarkdown(
  rateCard: Record<string, number>,
  opts: {
    groups?: Record<string, readonly string[]>;
    unit?: string;
    mdx?: boolean;
    /** Heading level for group titles. Default 3. */
    headingLevel?: number;
    messages?: PartialMessages;
  } = {},
): string {
  const mdx = opts.mdx ?? true;
  const m = resolveMessages(opts.messages);
  const unit = opts.unit ?? m.columnCost;
  const table = (entries: [string, number][]): string =>
    [
      `| ${m.columnTool} | ${unit} |`,
      "|---|---|",
      ...entries
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `| \`${esc(k, mdx)}\` | ${v} |`),
    ].join("\n");

  const all = Object.entries(rateCard);
  if (!opts.groups) return table(all);

  const hashes = "#".repeat(opts.headingLevel ?? 3);
  const grouped = new Set<string>();
  const sections: string[] = [];
  for (const [title, keys] of Object.entries(opts.groups)) {
    const entries = all.filter(([k]) => keys.includes(k));
    if (!entries.length) continue;
    for (const [k] of entries) grouped.add(k);
    sections.push(`${hashes} ${title}\n\n${table(entries)}`);
  }
  // Anything the caller forgot to group still appears — a silently dropped tool
  // is a tool a customer is charged for without being told.
  const rest = all.filter(([k]) => !grouped.has(k));
  if (rest.length) sections.push(`${hashes} ${m.otherGroup}\n\n${table(rest)}`);
  return sections.join("\n\n");
}

// ── The comparison table ────────────────────────────────────────────────────
//
// A feature matrix is cross-plan by nature — a row says something about EVERY
// plan — so it is authored as a table (section → group → row) rather than
// scattered across the plans, where a single row's label would have to be kept
// in sync in three places.
//
// Two things make it worth having in the config rather than in a component:
//
//  1. Cells are keyed BY PLAN. The shape this replaces was a positional tuple
//     zipped against the plan list, so adding or reordering a plan silently
//     shifted every cell in the table by a column.
//  2. A row can be DERIVED from the plan model (`from`), so the rows that restate
//     a configured number cannot contradict it. That drift was live: the matrix
//     advertised "50 searches a day" and "up to 10 members" against a config of
//     1000 credits a cycle and a limit of 100.
//
// Three ways to write a row, because most rows are the boring case:
//
//   { label: "Full-text search",  in: ["hobby", "pro"] }          // ✓ / ✓ / —
//   { label: "Searches",          values: { hobby: "50" } }        // text per plan
//   { label: "Members",           from: "members" }                // from the config

/** What a cell can say when it is authored by hand. A text value is
 *  {@link Localized}, so a matrix can serve several languages. */
export type CompareValue = boolean | number | Localized;

/** Fill a row from the plan model instead of by hand. */
export type CompareSource =
  /** `limits.members` — a count, or the unlimited label. */
  | "members"
  /** `included.credits` per cycle. */
  | "included"
  /** The plan's headline price for the selected interval. */
  | "price"
  /** The intervals the plan is sold on. */
  | "intervals"
  /** The names of its purchasable seat types. */
  | "seatTypes";

export interface CompareRow {
  label: Localized;
  /** One muted line under the label, when the label alone isn't enough. */
  hint?: Localized;
  /** Boolean shorthand: these plans get a tick, everything else a dash. */
  in?: readonly string[];
  /** Explicit per-plan values. A plan with no entry reads as "not included". */
  values?: Record<string, CompareValue>;
  /** Derive the value from each plan. Beats `values` when both are present,
   *  because the config is the thing that can't be wrong. */
  from?: CompareSource;
}

export interface CompareGroup {
  /** The sub-heading inside a section. */
  label: Localized;
  rows: readonly CompareRow[];
}

export interface CompareSection {
  title: Localized;
  description?: Localized;
  /** Icon NAME, resolved by the app — the library ships no components. */
  icon?: string;
  groups: readonly CompareGroup[];
}

export type CompareConfig = readonly CompareSection[];

/** Identity helper, for literal types and autocomplete on a compare config. */
export function defineCompare<T extends CompareConfig>(compare: T): T {
  return compare;
}

/** A resolved cell: the component renders a tick, a dash, or text — it never has
 *  to interpret a value. */
export type CompareCell =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "text"; text: string };

export interface CompareRowView {
  label: string;
  hint: string | null;
  /** Keyed by plan, and also ordered to match `columns`. */
  cells: Record<string, CompareCell>;
}

export interface CompareGroupView {
  label: string;
  rows: readonly CompareRowView[];
}

export interface CompareSectionView {
  title: string;
  description: string | null;
  icon: string | null;
  groups: readonly CompareGroupView[];
}

export interface CompareTableView {
  /** The plans, in the same order as the pricing cards. */
  columns: readonly { key: string; name: string; featured: boolean }[];
  sections: readonly CompareSectionView[];
}

export interface DeriveCompareOptions extends DerivePlanViewsOptions {
  /**
   * @deprecated Use `messages`, which covers these four and the rest of the
   * library's own words in one bundle. Kept working because it shipped.
   */
  labels?: {
    unlimited?: string;
    separator?: string;
    monthly?: string;
    yearly?: string;
  };
}

/**
 * Resolve a compare config against the plans into something a table can render.
 *
 * Columns come from the same derivation as the pricing cards, so the table's
 * plans are in the same order, with the same names, and a hidden or legacy plan
 * is absent from both.
 */
export function deriveCompareTable(
  plans: PlanCatalog,
  compare: CompareConfig,
  opts: DeriveCompareOptions = {},
): CompareTableView {
  const views = derivePlanViews(plans, opts);
  // `labels` predates the messages bundle; it maps onto four of its keys.
  const m = resolveMessages({ ...opts.labels, ...opts.messages });
  const locale = opts.locale ?? "en-US";
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const text = (v: Localized | undefined) => resolveLocalized(v, opts);

  const cellFor = (row: CompareRow, view: PlanView): CompareCell => {
    if (row.from) {
      switch (row.from) {
        case "members":
          return {
            kind: "text",
            text: view.members.max === null ? m.unlimited : number(view.members.max),
          };
        case "included":
          return view.included.credits > 0
            ? { kind: "text", text: number(view.included.credits) }
            : { kind: "no" };
        case "price":
          return view.price.headline
            ? { kind: "text", text: view.price.headline.text }
            : { kind: "text", text: view.sale === "quote" ? m.contactUs : m.free };
        case "intervals": {
          const names = view.intervals.map((i) => (i === "monthly" ? m.monthly : m.yearly));
          return names.length ? { kind: "text", text: names.join(m.separator) } : { kind: "no" };
        }
        case "seatTypes": {
          const names = view.price.rows.filter((r) => !r.shared).map((r) => r.label);
          return names.length ? { kind: "text", text: names.join(m.separator) } : { kind: "no" };
        }
      }
    }
    if (row.in) return row.in.includes(view.key) ? { kind: "yes" } : { kind: "no" };
    const value = row.values?.[view.key];
    if (value === undefined || value === false) return { kind: "no" };
    if (value === true) return { kind: "yes" };
    if (typeof value === "number") return { kind: "text", text: number(value) };
    const resolved = text(value);
    return resolved ? { kind: "text", text: resolved } : { kind: "no" };
  };

  return {
    columns: views.map((v) => ({ key: v.key, name: v.name, featured: v.featured })),
    sections: compare.map((section) => ({
      title: text(section.title) ?? "",
      description: text(section.description) ?? null,
      icon: section.icon ?? null,
      groups: section.groups.map((group) => ({
        label: text(group.label) ?? "",
        rows: group.rows.map((row) => ({
          label: text(row.label) ?? "",
          hint: text(row.hint) ?? null,
          cells: Object.fromEntries(views.map((v) => [v.key, cellFor(row, v)])),
        })),
      })),
    })),
  };
}

/** Every row label in a compare config, in one locale — for a search index, or to
 *  check that a row hasn't been written twice. */
export function compareRowLabels(
  compare: CompareConfig,
  opts: LocaleOptions = {},
): string[] {
  return compare.flatMap((s) =>
    s.groups.flatMap((g) =>
      g.rows.map((r) => resolveLocalized(r.label, opts) ?? "").filter(Boolean),
    ),
  );
}
