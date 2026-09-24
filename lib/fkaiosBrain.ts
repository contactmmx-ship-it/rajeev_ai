/**
 * Optional read-only bridge into the FKAIOS Brain — the single source of
 * truth for objectives/knowledge across Rajeev's whole business, not just
 * this app's own memory (fkaios-aura-blueprint1's founder-objective edge
 * function, action:"brain_context", RPC fkaios_brain_context()).
 *
 * Progressive enhancement, same pattern as every other layer here: any of
 * the three env vars missing -> "" -> memory.ts behaves exactly as it did
 * before this file existed. Never throws; a failed call degrades silently.
 *
 * Auth: the platform requires a valid Supabase JWT on Authorization, so this
 * sends FKAIOS_SUPABASE_ANON_KEY (publishable, not a secret) as the bearer
 * token, plus a separate X-Fkaios-Service-Token header carrying
 * FKAIOS_SERVICE_TOKEN. On the FKAIOS side that token unlocks brain_context
 * ONLY — this app can never submit or rerun an FKAIOS objective with it.
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
