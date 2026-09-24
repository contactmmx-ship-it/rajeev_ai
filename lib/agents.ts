import { getSupabaseAdmin } from "./supabase";
import { AssessmentScores } from "./methodology";

/**
 * V6 — AI Agents.
 *
 * This mirrors the FK AIOS agent set already envisioned elsewhere: Sales,
 * Finance, Ops, Inventory, Procurement, HR, Strategy — operating under a
 * governance layer, not autonomous action. Every function here PROPOSES;
 * nothing executes without an explicit decide() call, and agent_actions
 * itself is the audit trail (created_at / decided_at / decided_by /
 * executed_at / last_error).
 *
 * Execution is a webhook dispatch, deliberately generic rather than
 * wired to a specific system (Tally, a CRM, inventory software) I have
 * no real credentials for anyway. An approved action's full payload is
 * POSTed to a configured URL — point that at Zapier, Make, n8n, or a
 * custom endpoint, and THAT is what actually does something in Tally or
 * wherever. Without a webhook configured, approving an action is as far
 * as it goes, and executeAction says so plainly rather than pretending
 * to have integrated with a system it hasn't.
 */

export const AGENTS = {
  sales: "Sales",
  finance: "Finance",
  ops: "Ops",
  inventory: "Inventory",
  procurement: "Procurement",
  hr: "HR",
  strategy: "Strategy",
} as const;

export type AgentName = keyof typeof AGENTS;

function webhookUrlFor(agentName: AgentName): string | undefined {
  const perAgent = process.env[`AGENT_WEBHOOK_URL_${agentName.toUpperCase()}`];
  return perAgent || process.env.AGENT_WEBHOOK_URL;
}

export async function proposeAction(opts: {
  personId: string;
  agentName: AgentName;
  actionType: string;
  description: string;
  payload?: Record<string, unknown>;
}): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data, error } = await db
    .from("agent_actions")
    .insert({
      person_id: opts.personId,
      agent_name: opts.agentName,
      action_type: opts.actionType,
      description: opts.description,
      payload: opts.payload || {},
    })
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

export async function decideAction(opts: {
  actionId: string;
  decision: "approved" | "rejected";
  decidedBy: string;
}) {
  const db = getSupabaseAdmin();
  if (!db) throw new Error("Agents are not configured (Supabase missing)");

  const { error } = await db
    .from("agent_actions")
    .update({
      status: opts.decision,
      decided_at: new Date().toISOString(),
      decided_by: opts.decidedBy,
    })
    .eq("id", opts.actionId)
    .eq("status", "proposed"); // never overwrite a decision that's already been made

  if (error) throw error;
}

/**
 * Attempts to actually carry out an approved action by POSTing it to
 * that agent's configured webhook. Only runs on rows still in
 * 'approved' status — approving twice or re-executing an already-
 * executed action is a no-op, not a duplicate dispatch.
 *
 * Returns a result object rather than throwing on a failed dispatch:
 * a webhook being down or unconfigured is an expected, retryable state
 * for this table to hold, not an application error.
 */
export async function executeAction(
  actionId: string
): Promise<{ executed: boolean; reason?: string }> {
  const db = getSupabaseAdmin();
  if (!db) throw new Error("Agents are not configured (Supabase missing)");

  const { data: action, error: fetchErr } = await db
    .from("agent_actions")
    .select("*")
    .eq("id", actionId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!action) throw new Error("No such action");
  if (action.status !== "approved") {
    return { executed: false, reason: `Action is '${action.status}', not 'approved'` };
  }

  const url = webhookUrlFor(action.agent_name as AgentName);
  if (!url) {
    await db
      .from("agent_actions")
      .update({ status: "execution_failed", last_error: "No webhook configured for this agent" })
      .eq("id", actionId);
    return { executed: false, reason: "No webhook configured for this agent" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: action.id,
        person_id: action.person_id,
        agent_name: action.agent_name,
        action_type: action.action_type,
        description: action.description,
        payload: action.payload,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      await db
        .from("agent_actions")
        .update({ status: "execution_failed", last_error: `Webhook returned ${res.status}: ${detail.slice(0, 300)}` })
        .eq("id", actionId);
      return { executed: false, reason: `Webhook returned ${res.status}` };
    }

    await db
      .from("agent_actions")
      .update({ status: "executed", executed_at: new Date().toISOString(), last_error: null })
      .eq("id", actionId);
    return { executed: true };
  } catch (err) {
    await db
      .from("agent_actions")
      .update({ status: "execution_failed", last_error: String(err).slice(0, 300) })
      .eq("id", actionId);
    return { executed: false, reason: String(err) };
  }
}

export async function listActions(personId: string, status?: string) {
  const db = getSupabaseAdmin();
  if (!db) return null;

  let query = db.from("agent_actions").select("*").eq("person_id", personId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * The one real, working trigger in V6: a low systemization score is
 * exactly the kind of signal the Strategy agent should surface, so it
 * does — as a proposal Rajeev has to see and approve, same as any other
 * agent action. This is deliberately the only auto-triggered proposal
 * for now; more triggers are a scoping decision, not a technical one.
 */
export async function maybeProposeFromAssessment(opts: {
  personId: string;
  scores: AssessmentScores;
}): Promise<string | null> {
  if (opts.scores.systemization >= 50) return null;

  return proposeAction({
    personId: opts.personId,
    agentName: "strategy",
    actionType: "draft_sop_outline",
    description:
      "Systemization scored low in the last conversation — draft an SOP outline for this person's core operating process, for their review.",
    payload: { systemization_score: opts.scores.systemization },
  });
}
