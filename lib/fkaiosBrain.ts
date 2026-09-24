/**
 * Bridge into the FKAIOS Brain — the single source of truth for
 * objectives/knowledge across Rajeev's whole business, not just this app's
 * own memory (fkaios-aura-blueprint1's founder-objective edge function).
 * Two calls: getFkaiosBrainContext() (read) and submitFkaiosObjective()
 * (create — added for master spec requirement #28: Rajeev AI must feed
 * objectives into the SAME FKAIOS objective system, not keep them only in
 * this app's own `action_items` table).
 *
 * Progressive enhancement, same pattern as every other layer here: any of
 * the three env vars missing -> a no-op ({ok:false} / "") -> memory.ts
 * behaves exactly as it did before this file existed. Neither call throws;
 * a failure degrades silently and never blocks the caller's own work.
 *
 * Auth: the platform requires a valid Supabase JWT on Authorization, so this
 * sends FKAIOS_SUPABASE_ANON_KEY (publishable, not a secret) as the bearer
 * token, plus a separate X-Fkaios-Service-Token header carrying
 * FKAIOS_SERVICE_TOKEN. On the FKAIOS side that token unlocks exactly two
 * actions — brain_context (read) and submit_from_avatar (create an
 * objective, through the identical risk-assessment/approval pipeline a
 * human-submitted one goes through) — and nothing else: this app can never
 * rerun an FKAIOS objective or read anything beyond brain_context's scope
 * with it. See founder-objective/index.ts's own comment for the full
 * reasoning.
 */

let warnedOnce = false;

interface BrainObjective {
  raw_request?: string;
  status?: string;
  result_summary?: string;
}

interface BrainKnowledge {
  title?: string;
  content?: string;
}

interface BrainContext {
  objectives?: BrainObjective[];
  knowledge?: BrainKnowledge[];
}

function summarizeBrainContext(context: BrainContext): string {
  const parts: string[] = [];

  const objectives = Array.isArray(context.objectives) ? context.objectives : [];
  if (objectives.length > 0) {
    parts.push(
      "FKAIOS objectives already on record for this topic:\n" +
        objectives
          .slice(0, 3)
          .map((o) => `- ${o.raw_request ?? "(no description)"} [${o.status ?? "unknown"}]${o.result_summary ? `: ${String(o.result_summary).slice(0, 200)}` : ""}`)
          .join("\n")
    );
  }

  const knowledge = Array.isArray(context.knowledge) ? context.knowledge : [];
  if (knowledge.length > 0) {
    parts.push(
      "What FKAIOS already knows about this:\n" +
        knowledge
          .slice(0, 5)
          .map((k) => `- ${k.title ?? "(untitled)"}: ${String(k.content ?? "").slice(0, 200)}`)
          .join("\n")
    );
  }

  if (parts.length === 0) return "";
  return `FKAIOS Brain context (the shared business record, not this conversation's own memory — build on it, don't contradict it without asking):\n${parts.join("\n\n")}`;
}

export interface FkaiosObjectiveSubmission {
  ok: boolean;
  objectiveId?: string;
  status?: string;
  riskLevel?: string;
  error?: string;
}

/**
 * Submits an extracted action item to FKAIOS as a real objective, through
 * founder-objective's submit_from_avatar action. This is what makes
 * requirement #28 real: Rajeev AI does not keep business commitments only
 * in its own `action_items` table (a second, disconnected objective store,
 * exactly what the master spec forbids) — it also feeds FKAIOS's ONE
 * objective system, so the same commitment enters FKAIOS's planning/
 * allocation/execution/verification loop.
 *
 * Same degrade-silently contract as getFkaiosBrainContext(): any missing
 * env var, or any failure, returns {ok:false} and NEVER throws. The caller
 * (memory.ts) treats this as fire-and-forget — FKAIOS being unreachable
 * must never break a call's own extraction pass.
 */
export async function submitFkaiosObjective(description: string): Promise<FkaiosObjectiveSubmission> {
  const url = process.env.FKAIOS_FOUNDER_OBJECTIVE_URL;
  const anonKey = process.env.FKAIOS_SUPABASE_ANON_KEY;
  const serviceToken = process.env.FKAIOS_SERVICE_TOKEN;
  if (!url || !anonKey || !serviceToken) return { ok: false, error: "not configured" };
  const objective = description.trim();
  if (objective.length < 10) return { ok: false, error: "too short for an FKAIOS objective (min 10 chars)" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${anonKey}`,
        "X-Fkaios-Service-Token": serviceToken,
      },
      body: JSON.stringify({ action: "submit_from_avatar", objective: objective.slice(0, 2000) }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      console.error("[fkaiosBrain] submit_from_avatar failed (non-blocking):", data?.error ?? res.status);
      return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, objectiveId: data.objectiveId, status: data.status, riskLevel: data.riskLevel };
  } catch (err) {
    console.error("[fkaiosBrain] submit_from_avatar call failed (non-blocking):", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetches and summarizes FKAIOS's knowledge about `topic` (typically the
 * person's company/brand name). Returns "" if not configured, the topic is
 * too short, the call fails, or FKAIOS has nothing on record — never throws.
 */
export async function getFkaiosBrainContext(topic: string): Promise<string> {
  const url = process.env.FKAIOS_FOUNDER_OBJECTIVE_URL;
  const anonKey = process.env.FKAIOS_SUPABASE_ANON_KEY;
  const serviceToken = process.env.FKAIOS_SERVICE_TOKEN;
  if (!url || !anonKey || !serviceToken) return "";
  if (!topic || topic.trim().length < 2) return "";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${anonKey}`,
        "X-Fkaios-Service-Token": serviceToken,
      },
      body: JSON.stringify({ action: "brain_context", topic: topic.trim().slice(0, 200) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (!data?.ok || !data?.context) return "";
    return summarizeBrainContext(data.context as BrainContext);
  } catch (err) {
    if (!warnedOnce) {
      console.error("[fkaiosBrain] brain_context call failed (non-blocking, memory still works):", err);
      warnedOnce = true;
    }
    return "";
  }
}
