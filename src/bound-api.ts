// The library's org-scoped functions, with the wiring already applied.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// 37 functions in this library take `(adapter, …)`, and several also want
// `config`, `plans`, the ledger and a plan resolver. `createBilling` already holds
// every one of those values — so every consumer was re-binding them by hand.
// Measured on the first two: scartoffie hand-wrote 39 wrappers, 39 of its 54
// exports, and they bound nothing else:
//
//     export function workspacePaymentMethods(orgId) { return listPaymentMethods(adapter, orgId) }
//     export function listWorkspaceSeats(orgId)      { return listSeatAssignments(adapter, orgId) }
//     export function workspaceInvoices(orgId, n)    { return listOrgInvoices(adapter, orgId, n) }
//
// ~40 files of mechanical binding before a line of product code, per app, and the
// same 40 again for the next one.
//
// The subtler reason is correctness, not volume. A hand-written wrapper is a place
// to put logic, and the logic that ends up there is exactly the logic that must not
// be duplicated: which cycle key a grant is filed under, which plan the meter
// thinks the org is on, which ledger a usage read goes to. A consumer that files a
// top-up against a calendar month while the meter reads the subscription period
// grants nothing, silently — that defect has happened, and it happened in a
// wrapper. Binding once here removes the place it can happen.
//
// ── What is NOT here ────────────────────────────────────────────────────────
//
// Functions taking a Stripe customer id rather than an org (`getCreditBalance`,
// `setAutoReloadSettings`, `quoteCreditPurchase`, …). They are not org-scoped, so
// there is nothing to bind, and `api.customerId(orgId)` is the one line that gets
// you from one to the other. Importing them from the root is already the short way.

import { enforceAccess, enforceAdmin, enforceCredits, enforceMember, isInternalOrg } from "./auth.js";
import {
  ensureStripeCustomer,
  getBillingCustomerId,
  getOrgInvoice,
  getOrgSubscription,
  listOrgInvoices,
  orgInvoicePdfUrl,
} from "./billing.js";
import { getBillingProfile, updateBillingProfile } from "./billing-profile.js";
import { listCustomerTaxIds, setCustomerTaxId } from "./tax-ids.js";
import {
  attachedPaymentMethod,
  createCardSetupCheckoutSession,
  createCardSetupIntent,
  detachPaymentMethod,
  listPaymentMethods,
  prunePaymentMethods,
  setDefaultPaymentMethod,
  touchPaymentMethod,
  DEFAULT_MAX_CARDS,
} from "./payment-methods.js";
import { assignSeatType, clearMemberRecords, getSeatType, listSeatAssignments, seatAssignable, seatCapacity } from "./seats.js";
import { cancelPlan, changePlan, previewPlanChange } from "./subscription.js";
import {
  approveTopUp,
  denyTopUp,
  extraAllowance,
  grantExtraAllowance,
  grantTopUp,
  listTopUpRequests,
  pendingTopUpFor,
  requestExtraAllowance,
  requestTopUp,
} from "./topup.js";
import { closeWorkspace, findOrphanedSubscriptions } from "./close-workspace.js";
import { topUpTargetOf } from "./allowance.js";
import {
  defaultSeatOf,
  seatLadder,
  seatTypeExists,
  isSatisfied,
  listPlanRequests,
  nextUsageAsk,
  usageAction,
  pendingPlanRequest,
  requestPlanChange,
  requestSeatChange,
  resolvePlanRequest,
} from "./plan-request.js";
import { currentCycle, resolveAllowance } from "./allowance.js";
import { callerWithSeat, memberUsage, usageSummary } from "./usage.js";
import { planModel, type PlanCatalog } from "./plans.js";
import type { UsageLedger } from "./usage-ledger.js";
import type { BillingAdapter, ResolvedConfig } from "./types.js";

/** What `createBilling` already resolved, and what everything below closes over. */
export interface BoundApiDeps {
  adapter: BillingAdapter;
  config: ResolvedConfig;
  plans?: PlanCatalog;
  ledger?: UsageLedger;
  /** How to find the org's current plan key. The meter's resolver, so a usage read
   *  and the gate that refused a call agree about which plan is in force. */
  resolvePlan?: (orgId: string) => Promise<string | null>;
}

type Caller = { kind: "user" | "api"; id?: string; seatType?: string };

export function createBoundApi(deps: BoundApiDeps) {
  const { adapter, config, ledger } = deps;
  const plans = deps.plans ?? {};

  // One definition of "which plan is this org on", used by every plan-aware call
  // below. Falls back to the adapter's own subscription record, which is what
  // `registerBillingTools` does — so the bound API and the tools cannot disagree.
  const planOf = async (orgId: string): Promise<string | null> =>
    deps.resolvePlan
      ? await deps.resolvePlan(orgId)
      : ((await adapter.getSubscription?.(orgId))?.plan ?? null);

  /**
   * WHICH window to raise for this member, resolved rather than assumed.
   *
   * Both the ask and the grant go through it, so they cannot disagree about what is being
   * topped up — and neither can raise the seat pack while a tighter window is the thing
   * actually refusing the member, which would grant credits that change nothing.
   */
  const topUpTarget = async (
    orgId: string,
    memberId: string,
    /**
     * `blocked` distinguishes "nothing is refusing them" from "the read failed", which the
     * bare `{}` could not. The ASK needs that difference — a request from somebody at 40% is
     * a question with no answer — while the GRANT deliberately still allows on a failed
     * read, since a stuck customer is worse than a grant on the wrong window.
     */
  ): Promise<{ windowKey?: string; basis?: number; blocked: boolean | null }> => {
    try {
      const plan = await planOf(orgId);
      const state = await resolveAllowance(adapter, config, {
        orgId,
        plans,
        plan,
        ledger,
        // WITH the seat resolved. Without it every seat-typed rate window is filtered out,
        // so a member capped by their weekly seat limit looked entirely unblocked and the
        // control that should have offered an upgrade vanished.
        caller: await callerWithSeat(adapter, {
          orgId,
          model: planModel(plans, plan),
          caller: { kind: "user", id: memberId },
        }),
      });
      const target = topUpTargetOf(state);
      return {
        blocked: target != null,
        ...(target?.kind === "rate" ? { windowKey: target.windowKey, basis: target.basis } : {}),
      };
    } catch {
      // Unreadable usage must not stop an owner granting: falling back to the seat pack is
      // the old behaviour, and a grant on the wrong window is recoverable where a refusal
      // to grant at all is just a stuck customer.
      return { blocked: null };
    }
  };

  return {
    /** The org's Stripe customer, created on first use. */
    customerId: (orgId: string, email?: string) =>
      ensureStripeCustomer(adapter, orgId, email, config),
    /** The org's Stripe customer if it already has one, else null — no creation. */
    customerIdIfAny: (orgId: string) => getBillingCustomerId(adapter, orgId),
    /** Unmetered internal org (a domain in `config.internalDomains`). */
    isInternal: (orgId: string) => isInternalOrg(adapter, orgId, config.internalDomains),

    /** Which plan the org is on, by the same resolver the meter uses. */
    plan: planOf,

    profile: {
      get: (orgId: string) => getBillingProfile(adapter, orgId),
      update: (orgId: string, patch: Parameters<typeof updateBillingProfile>[2]) =>
        updateBillingProfile(adapter, orgId, patch),
    },

    taxIds: {
      list: (orgId: string) => listCustomerTaxIds(adapter, orgId),
      set: (orgId: string, input: Parameters<typeof setCustomerTaxId>[2]) =>
        setCustomerTaxId(adapter, orgId, input),
    },

    cards: {
      list: (orgId: string) => listPaymentMethods(adapter, orgId),
      setDefault: (orgId: string, paymentMethodId: string) =>
        setDefaultPaymentMethod(adapter, orgId, paymentMethodId),
      remove: (orgId: string, paymentMethodId: string) =>
        detachPaymentMethod(adapter, orgId, paymentMethodId),
      setupIntent: (orgId: string, opts: Parameters<typeof createCardSetupIntent>[2]) =>
        createCardSetupIntent(adapter, orgId, opts),
      setupCheckout: (
        orgId: string,
        opts: Parameters<typeof createCardSetupCheckoutSession>[2],
      ) => createCardSetupCheckoutSession(adapter, orgId, opts),
      /**
       * Finish a save: the FIRST card becomes the default, asked for or not.
       *
       * A customer with one card and no default has a card on file and nothing chargeable —
       * every invoice and every auto-reload reads the default — so this is not a
       * convenience. Consumers were doing it themselves in whatever callback their checkout
       * returned to, which is one place per flow.
       */
      attached: (orgId: string, paymentMethodId: string, opts?: { setDefault?: boolean }) =>
        attachedPaymentMethod(adapter, orgId, paymentMethodId, opts),
      /** Least-recently-used eviction down to `config.paymentMethods.maxCards`, never
       *  touching the default. Call after attaching. */
      prune: (orgId: string, max?: number) =>
        prunePaymentMethods(adapter, orgId, max ?? config.paymentMethods?.maxCards ?? DEFAULT_MAX_CARDS),
      /** Stamp a card as just-charged, so the prune above can be LRU rather than oldest. */
      touch: (paymentMethodId: string) => touchPaymentMethod(paymentMethodId),
    },

    invoices: {
      list: (orgId: string, limit?: number) => listOrgInvoices(adapter, orgId, limit),
      get: (orgId: string, invoiceId: string) => getOrgInvoice(adapter, orgId, invoiceId),
      pdfUrl: (orgId: string, invoiceId: string) => orgInvoicePdfUrl(adapter, orgId, invoiceId),
    },

    subscription: {
      get: (orgId: string) => getOrgSubscription(adapter, orgId),
      // `plans`, `config` and `currency` bound; the caller supplies only the move.
      change: (
        orgId: string,
        to: Parameters<typeof changePlan>[2]["to"],
        opts: Omit<Parameters<typeof changePlan>[2], "plans" | "to" | "config" | "currency"> = {},
      ) => changePlan(adapter, orgId, { ...opts, plans, to, config, currency: config.currency }),
      /** Quote a change. Pass the SAME `timing`/`proration` you will pass to
       *  `change`, or you are quoting a policy the app does not apply. */
      preview: (
        orgId: string,
        to: Parameters<typeof previewPlanChange>[2]["to"],
        opts: Omit<Parameters<typeof previewPlanChange>[2], "plans" | "to" | "currency"> = {},
      ) => previewPlanChange(adapter, orgId, { ...opts, plans, to, currency: config.currency }),
      /**
       * The OTHER ask: move the workspace up a tier.
       *
       * Queued, never applied — approving does not charge anybody. `change_plan` is the
       * upgrade, and it takes a payment, which is not something a member's request may
       * trigger on an owner's behalf.
       */
      requests: {
        list: (orgId: string) => listPlanRequests(adapter, orgId),
        /** That member's open ask, or null once the workspace has reached the plan anyway. */
        pending: async (orgId: string, memberId: string) =>
          pendingPlanRequest(adapter, orgId, memberId, { plans, currentPlan: await planOf(orgId) }),
        ask: async (orgId: string, memberId: string, opts: { plan?: string; note?: string } = {}) =>
          requestPlanChange(adapter, orgId, { ...opts, memberId, plans, currentPlan: await planOf(orgId) }),
        /** Ask for a bigger SEAT — the right ask while one exists above them. */
        askSeat: async (orgId: string, memberId: string, opts: { seatType?: string; note?: string } = {}) =>
          requestSeatChange(adapter, orgId, {
            ...opts,
            memberId,
            plans,
            currentPlan: await planOf(orgId),
            currentSeatType: await getSeatType(adapter, orgId, memberId),
          }),
        /**
         * WHICH ask to offer this person: a bigger seat, more usage, or a plan change.
         *
         * One call so a screen cannot invent its own ladder — a Standard member offered a
         * top-up gets a few days and is in the same place next week, which is the mistake
         * this exists to prevent.
         */
        next: async (
          orgId: string,
          memberId: string,
          /** Who is asking. Omit and the answer is owner-level, the reading an org API key
           *  with no principal behind it already gets from `enforceAdmin`. */
          actor?: { isAdmin?: boolean },
        ) => {
          const plan = await planOf(orgId);
          const model = planModel(plans, plan);
          // The same resolved caller the usage SCREEN uses, so the ladder and the bars cannot
          // disagree about which windows apply to this person.
          const caller = await callerWithSeat(adapter, {
            orgId,
            model,
            caller: { kind: "user" as const, id: memberId, seatType: undefined as string | undefined },
          });
          const state = await resolveAllowance(adapter, config, { orgId, plans, plan, ledger, caller });
          const input = {
            blocked: topUpTargetOf(state),
            // The RESOLVED seat, not the raw assignment: an unassigned member draws the
            // default seat, so the rung above is measured from there.
            seatType: caller?.seatType ?? null,
            plans,
            currentPlan: plan,
          };
          const ask = nextUsageAsk(model, input);
          // The rung AND who may act on it. The second half used to be the consumer's, and
          // every consumer worked it out again in the component that draws the button — so
          // an agent hitting the same wall got the rung and no idea whether buying was its
          // call. `action` names the next tool, which is the whole answer for a headless
          // caller and one branch for a UI.
          return ask
            ? { ...ask, ...usageAction(model, { ...input, actor, purchase: config.roles?.purchase })! }
            : null;
        },
        resolve: (orgId: string, requestId: string, decision: "done" | "denied") =>
          resolvePlanRequest(adapter, orgId, requestId, decision),
        /** Has the workspace already reached what this asked for? */
        satisfied: async (orgId: string, request: Parameters<typeof isSatisfied>[0]) =>
          isSatisfied(request, plans, await planOf(orgId)),
      },
      cancel: (
        orgId: string,
        opts: Omit<Parameters<typeof cancelPlan>[2], "plans" | "currency"> = {},
      ) => cancelPlan(adapter, orgId, { ...opts, plans, currency: config.currency }),
    },

    seats: {
      list: (orgId: string) => listSeatAssignments(adapter, orgId),
      get: (orgId: string, memberId: string) => getSeatType(adapter, orgId, memberId),
      /**
       * WHICH seat a member draws when nobody has assigned them one.
       *
       * A real seat — the plan's cheapest non-shared type — not an absence, which is why a
       * picker must not offer "default" as a fourth choice beside the ones the plan sells:
       * that names a seat type no config declares. Measured on a consumer: a member with no
       * assignment was badged "Predefinito" on its members page while its usage page, reading
       * the same person through `MemberUsage.seatType`, said "Standard". Both were rendering
       * the same fact and only one of them had asked the library for it.
       */
      defaultType: async (orgId: string) => {
        const model = planModel(plans, await planOf(orgId));
        return model ? defaultSeatOf(model) : null;
      },
      /** Drop a workspace's entries from these members' own metadata — what `workspace.close`
       *  calls, and what removing a single member should call for that member. */
      clearRecords: (orgId: string, memberIds: readonly string[]) =>
        clearMemberRecords(adapter, orgId, memberIds),
      /**
       * Assign a seat, refusing a `memberId` that is not in this workspace.
       *
       * The check lives HERE as well as in the `assign_seat_type` tool, because a consumer
       * that writes its own server action bypasses the tool entirely — scartoffie's does, and
       * so its admin path had no membership check at all while the tool's was being fixed.
       * That is the failure this file exists to prevent: the logic a hand-written wrapper ends
       * up owning is exactly the logic that must not be duplicated.
       *
       * `assignSeatType` itself stays a pure storage write, so an app that deliberately seats
       * a not-yet-active invitee can still call it directly.
       */
      assign: async (orgId: string, memberId: string, seatType: string | null) => {
        const stranger = await enforceMember(adapter, orgId, memberId, "assign seat");
        if (stranger) throw new Error(stranger.content[0].text);
        const model = planModel(plans, await planOf(orgId));
        // Does THIS plan sell that seat? The tool checked and this did not, so the one path
        // a consumer's own server action takes was the one that would write an undeclared
        // seat key — `seatAssignable` fails open on a type it cannot find, by design, so
        // nothing downstream caught it either.
        if (seatType && model && !seatTypeExists(model, seatType)) {
          const sells = model.seatTypes.map((t) => t.key).join(", ");
          throw new Error(
            `This workspace's plan (${model.key}) does not sell a "${seatType}" seat. It sells: ${sells || "(no seats)"}.`,
          );
        }
        // A seat is a PRICE and this write does not touch the subscription, so an unchecked
        // assign gives the most expensive seat away. Same guard the tool applies.
        const room = await seatAssignable(adapter, orgId, model, memberId, seatType);
        if (!room.ok) {
          throw new Error(
            room.reason === "not_purchased"
              ? `Not enough ${seatType} seats purchased (${room.purchased} bought, ${room.assigned} in use).`
              : `The plan allows no more ${seatType} seats (${room.assigned} in use).`,
          );
        }
        return assignSeatType(adapter, orgId, memberId, seatType);
      },
      /** Room left on a seat type: `{ assigned, purchased, max, remaining }`, `remaining: null`
       *  when nothing declares a ceiling. What a picker needs before it offers the option. */
      capacity: async (orgId: string, seatType: string) =>
        seatCapacity(adapter, orgId, planModel(plans, await planOf(orgId)), seatType),
      /** The ladder for this org's plan, cheapest rung first, shared seats excluded. */
      ladder: async (orgId: string) => {
        const model = planModel(plans, await planOf(orgId));
        return model ? seatLadder(model).map((s) => s.key) : [];
      },
      /** The raw write, no membership check — for seating an invitee who has not accepted. */
      assignUnchecked: (orgId: string, memberId: string, seatType: string | null) =>
        assignSeatType(adapter, orgId, memberId, seatType),
    },

    usage: {
      /** Every window that applies, plus pool/pack/wallet. `plan` and `ledger` bound. */
      summary: (
        orgId: string,
        opts: { caller?: Caller; locale?: Parameters<typeof usageSummary>[2]["locale"]; now?: number } = {},
      ) =>
        planOf(orgId).then((plan) =>
          usageSummary(adapter, config, { ...opts, orgId, plans, plan, ledger }),
        ),
      /** Per-member breakdown for an admin view. N ledger reads — cache it. */
      byMember: (
        orgId: string,
        members: Parameters<typeof memberUsage>[2]["members"],
        opts: { now?: number } = {},
      ) =>
        planOf(orgId).then((plan) =>
          memberUsage(adapter, config, { ...opts, orgId, plans, plan, members, ledger }),
        ),
      /**
       * The raw allowance state the meter gates on.
       *
       * The caller's SEAT is resolved here, exactly as `summary` and
       * `subscription.requests.next` resolve it — a caller carrying only an id matches no
       * seat-typed window, so `state.limits` came back without the very window that was
       * refusing them and `topUpTargetOf` read "nothing is blocked". Measured on a Premium
       * member sitting at 100% of their week: the ladder (which resolves the seat) offered
       * extra usage while this read (which did not) reported no window to raise, so the
       * screen fell through to a plan upgrade nobody needed. Whoever asks the question, the
       * answer has to be about the same person.
       */
      allowance: (
        orgId: string,
        opts: Omit<Parameters<typeof resolveAllowance>[2], "orgId" | "plans" | "plan" | "ledger"> = {},
      ) =>
        planOf(orgId).then(async (plan) =>
          resolveAllowance(adapter, config, {
            ...opts,
            caller: await callerWithSeat(adapter, {
              orgId,
              model: planModel(plans, plan),
              caller: opts.caller,
            }),
            orgId,
            plans,
            plan,
            ledger,
          }),
        ),
      /**
       * The cycle key anything filed against a cycle must use.
       *
       * Exposed because getting it wrong is silent: a grant written under a
       * calendar month that the meter reads as a subscription period grants
       * nothing, and nothing errors.
       */
      cycle: (orgId: string, opts: { now?: number } = {}) =>
        planOf(orgId).then((plan) => currentCycle(adapter, { ...opts, orgId, plans, plan })),
    },

    topUps: {
      list: (orgId: string) => listTopUpRequests(adapter, orgId),
      /**
       * File a request. The cycle is resolved here rather than taken from the
       * caller, which is the whole point — see `usage.cycle`.
       */
      request: async (
        orgId: string,
        req: { memberId: string; amount: number; id?: string; cycle?: string },
      ) => {
        const stranger = await enforceMember(adapter, orgId, req.memberId, "request a top-up");
        if (stranger) throw new Error(stranger.content[0].text);
        const cycle = req.cycle ?? (await currentCycle(adapter, { orgId, plans, plan: await planOf(orgId) })).key;
        const id = req.id ?? crypto.randomUUID();
        await requestTopUp(adapter, orgId, {
          id,
          memberId: req.memberId,
          amount: req.amount,
          cycle,
          createdAt: new Date().toISOString(),
        });
        return { id, cycle };
      },
      /**
       * Ask WITHOUT naming an amount — the plan's share of that member's seat pack.
       *
       * What a "request more usage" button calls: the person pressing it knows they are out,
       * not what a reasonable top-up is. Refuses a second open ask for the same cycle and
       * returns the one already waiting, so the button can render as pending rather than
       * queueing the same question again.
       */
      requestExtra: async (
        orgId: string,
        memberId: string,
        opts: { percent?: number; amount?: number; id?: string } = {},
      ) => {
        const { blocked, ...target } = await topUpTarget(orgId, memberId);
        return requestExtraAllowance(adapter, {
          ...opts,
          ...target,
          blocked,
          orgId,
          plans,
          plan: await planOf(orgId),
          memberId,
        });
      },
      /** That member's own ask still waiting on an answer, or null. */
      pending: (orgId: string, memberId: string, cycle: string) =>
        pendingTopUpFor(adapter, orgId, memberId, cycle),
      approve: (orgId: string, requestId: string) => approveTopUp(adapter, orgId, requestId),
      deny: (orgId: string, requestId: string) => denyTopUp(adapter, orgId, requestId),
      /** Grant outright, in credits, against a cycle you name. */
      grant: (orgId: string, input: Parameters<typeof grantTopUp>[2]) =>
        grantTopUp(adapter, orgId, input),
      /**
       * Grant as a percentage of that member's own seat pack (default 25%).
       *
       * Membership-checked for the same reason `seats.assign` is: an admin screen passes a
       * `memberId` straight from its own UI, and being an admin of YOUR workspace says nothing
       * about whether that user is in it. scartoffie's grant control reaches the library
       * through exactly this function.
       */
      grantExtra: async (
        orgId: string,
        memberId: string,
        opts: { percent?: number; grantedBy?: string; id?: string } = {},
      ) => {
        const stranger = await enforceMember(adapter, orgId, memberId, "grant extra allowance");
        if (stranger) throw new Error(stranger.content[0].text);
        const plan = await planOf(orgId);
        const { blocked: _blocked, ...target } = await topUpTarget(orgId, memberId);
        // No `blocked` gate on the GRANT: an owner may top somebody up before they hit the
        // wall — going away on Friday, a demo on Monday — and refusing that would be the
        // library second-guessing a decision that is theirs and costs nothing.
        return grantExtraAllowance(adapter, { ...opts, ...target, orgId, plans, plan, memberId });
      },
      /** Extra already granted to a member for a cycle. */
      granted: (orgId: string, memberId: string, cycle: string) =>
        extraAllowance(adapter, orgId, memberId, cycle),
    },

    workspace: {
      /**
       * Close a workspace: stop its billing, KEEP its invoices, return each member's metadata
       * budget, then remove it — in that order, and it refuses to remove one whose billing is
       * still live. The old one-call deletion left a subscription charging a card for a
       * workspace that no longer existed, with the pointer to it destroyed.
       */
      close: (orgId: string, opts?: Parameters<typeof closeWorkspace>[2]) =>
        closeWorkspace(adapter, orgId, opts),
      /** Live subscriptions whose org no longer resolves — the wreckage of the old way. */
      orphans: (opts?: Parameters<typeof findOrphanedSubscriptions>[1]) =>
        findOrphanedSubscriptions(adapter, opts),
    },

    /**
     * The gates, for a surface that is not an MCP tool.
     *
     * A server action has a session rather than an API key, so it wraps the call in
     * `runWithPrincipal` and these read the same AsyncLocalStorage the tools do —
     * which is why they must come from the same module instance, and why binding
     * them here rather than re-importing is the safe way round.
     */
    auth: {
      access: () => enforceAccess(adapter),
      admin: (action: string) => enforceAdmin(adapter, action),
      /** Refuse a `member_id` that is not in this workspace. Any surface taking one from a
       *  caller needs it: the org gate answers "which workspace", never "is this person in
       *  it". */
      member: (orgId: string, memberId: string, action: string) =>
        enforceMember(adapter, orgId, memberId, action),
      credits: (orgId: string, toolName: string, cost: number) =>
        enforceCredits(adapter, config, orgId, toolName, cost),
    },
  };
}

export type BillingApi = ReturnType<typeof createBoundApi>;
