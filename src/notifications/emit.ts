import { ADMIN_ROLE_SLUG, type BillingAdapter, type OrgMember } from "../types.js";
import type { Audience, BillingNotification, Notifier, Notify } from "./index.js";

// Who gets told, and the one place that swallows a failed telling.
//
// Kept apart from `./index.ts` so the wire format (the event union, the signature, the
// transport) stays free of the adapter: a consumer's route imports that half to VERIFY a
// delivery, and has no business pulling the storage seam in to do it.

/**
 * Build the fire-and-forget `Notify` every call site inside the library holds.
 *
 * Two things happen here that deliberately do NOT happen at the call sites:
 *
 * 1. **Recipients are resolved.** A call site knows the workspace and, at most, a member id;
 *    turning that into addresses is a membership question, and answering it eight times is
 *    how eight answers drift. It also has to be async, and a call site that awaited it would
 *    be blocking a metered call on a WorkOS round trip to send an email.
 * 2. **Failure is swallowed, once.** Every notification describes something that ALREADY
 *    happened — the invitation exists, the credit is granted, the call was metered. A
 *    delivery that fails must not undo it. One `.catch()` here beats eight, where the ninth
 *    call site is the one that forgets.
 */
export function createEmitter(
  adapter: BillingAdapter,
  notifier: Notifier | undefined,
  onError?: (e: unknown) => void,
): Notify | undefined {
  if (!notifier) return undefined;

  const fail = (e: unknown) => {
    try {
      onError?.(e);
    } catch {
      // A broken error handler is not worth a second failure.
    }
  };

  return (event) => {
    const audience = (event as { audience?: Audience }).audience;
    void (async () => {
      const resolved = await withRecipients(adapter, event, audience);
      // Nothing to tell anybody: an adapter that cannot list members, a workspace whose
      // admins have no address on file. Sending to nobody is not an error, but it is not
      // worth a round trip either.
      //
      // Only for an ADDRESSED event. An event carrying no audience was never this library's
      // to address: its recipients are the DEPLOYMENT's (an ops inbox, a Slack channel, a
      // CRM) and the consumer routes it, so an empty `to` there is the intended shape rather
      // than a failed lookup.
      //
      // Every event shipped today is addressed — the one that was not, `quote.requested`,
      // went when custom pricing became a plan change. The branch stays because it is the
      // difference between the next unaddressed event being ROUTED and being silently
      // dropped, which is what happened to that one: the single event its operators existed
      // to receive was the single event never delivered, and nothing errored.
      if (audience && !resolved.to.length) return;
      await notifier.deliver({ ...resolved, at: Date.now() });
    })().catch(fail);
  };
}

/** Fill `to` (and a member's email, where the event carries one) from the adapter. */
async function withRecipients(
  adapter: BillingAdapter,
  event: BillingNotification & { id: string },
  audience: Audience | undefined,
): Promise<BillingNotification & { id: string }> {
  if (!audience) return event;
  if (audience.kind === "email") return { ...event, to: [audience.email] };

  const members = await listOrgMembers(adapter, event.orgId);
  const to =
    audience.kind === "admins"
      ? members.filter((m) => m.roleSlug === ADMIN_ROLE_SLUG).map((m) => m.email)
      : members.filter((m) => m.userId === audience.memberId).map((m) => m.email);

  // The member's own address, when the event names one and the caller could not. The same
  // list answers both questions, so it is one lookup, not two.
  const data = event.data as { member?: { id: string; email: string | null } };
  const member =
    data && "member" in data && data.member && !data.member.email
      ? members.find((m) => m.userId === data.member!.id)
      : null;

  return {
    ...event,
    to: to.filter((e): e is string => Boolean(e)),
    ...(member ? { data: { ...event.data, member: { ...data.member, email: member.email } } } : {}),
  } as BillingNotification & { id: string };
}

async function listOrgMembers(adapter: BillingAdapter, orgId: string): Promise<OrgMember[]> {
  if (!adapter.listMembers) return [];
  try {
    return await adapter.listMembers(orgId);
  } catch (e) {
    // An unreadable membership means nobody gets told, which is the same outcome as no
    // notifier at all — never a thrown error into the thing that happened.
    return [];
  }
}
