import { getSupabaseAdmin } from "./supabase";
import { callStructured } from "./openaiText";
import {
  ASSESSMENT_DIMENSIONS,
  AssessmentScores,
  computeOverallScore,
  computeTier,
} from "./methodology";
import { maybeProposeFromAssessment } from "./agents";
import { getFkaiosBrainContext } from "./fkaiosBrain";

export type TranscriptTurn = { role: "user" | "assistant"; text: string; ts: number };

export type CompanyBrand = {
  id: string;
  name: string;
  brandName: string;
  primaryColor: string;
  logoUrl: string | null;
};

export type MemoryContext = {
  personId: string;
  isConfigured: boolean;
  isReturning: boolean;
  factCount: number;
  openActionItems: string[];
  company: CompanyBrand | null;
  /** Ready to drop straight into the realtime session's instructions. */
  contextForPrompt: string;
};

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "identity",
              "business",
              "goal",
              "decision",
              "project",
              "constraint",
              "preference",
              "fact",
            ],
          },
          // A short stable slug for what this fact is ABOUT, e.g.
          // "primary_business", "2026_revenue_target" — used to detect
          // when a new fact supersedes an old one instead of piling up
          // beside it. Not a category; a topic key.
          fact_key: { type: "string" },
          content: { type: "string" },
        },
        required: ["category", "fact_key", "content"],
        additionalProperties: false,
      },
    },
    updated_summary: { type: "string" },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          project_hint: {
            type: ["string", "null"],
            description: "Name of the project/business this belongs to, if any was mentioned.",
          },
        },
        required: ["description", "project_hint"],
        additionalProperties: false,
      },
    },
    assessment: {
      type: "object",
      description:
        "Only fill this in if the conversation covered enough about the person's business to score it. If not, set applicable to false and leave the rest at 0.",
      properties: {
        applicable: { type: "boolean" },
        commercial_attractiveness: { type: "integer" },
        operational_organization: { type: "integer" },
        differentiation: { type: "integer" },
        financial_clarity: { type: "integer" },
        systemization: { type: "integer" },
        founder_independence: { type: "integer" },
        technology_readiness: { type: "integer" },
      },
      required: [
        "applicable",
        "commercial_attractiveness",
        "operational_organization",
        "differentiation",
        "financial_clarity",
        "systemization",
        "founder_independence",
        "technology_readiness",
      ],
      additionalProperties: false,
    },
  },
  required: ["facts", "updated_summary", "action_items", "assessment"],
  additionalProperties: false,
} as const;

/**
 * V2: looks a person up by their authenticated Supabase user id, not a
 * browser-generated UUID. Falls back to "no memory" cleanly if Supabase
 * isn't configured — the voice path must never depend on this.
 */
export async function getOrCreatePerson(authUserId: string | undefined): Promise<MemoryContext> {
  const db = getSupabaseAdmin();

  if (!db || !authUserId) {
    return {
      personId: authUserId || crypto.randomUUID(),
      isConfigured: false,
      isReturning: false,
      factCount: 0,
      openActionItems: [],
      company: null,
      contextForPrompt: "",
    };
  }

  let row: { id: string; summary: string | null; company_id: string | null } | null = null;

  const { data: existing } = await db
    .from("people")
    .select("id, summary, company_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  row = existing;

  if (!row) {
    const { data, error } = await db
      .from("people")
      .insert({ auth_user_id: authUserId })
      .select("id, summary, company_id")
      .single();
    if (error) throw error;
    row = data;
  } else {
    await db.from("people").update({ last_seen_at: new Date().toISOString() }).eq("id", row.id);
  }

  let company: CompanyBrand | null = null;
  if (row.company_id) {
    const { data: companyRow } = await db
      .from("companies")
      .select("id, name, brand_name, primary_color, logo_url")
      .eq("id", row.company_id)
      .maybeSingle();
    if (companyRow) {
      company = {
        id: companyRow.id,
        name: companyRow.name,
        brandName: companyRow.brand_name,
        primaryColor: companyRow.primary_color,
        logoUrl: companyRow.logo_url,
      };
    }
  }

  const { count } = await db
    .from("memory_facts")
    .select("id", { count: "exact", head: true })
    .eq("person_id", row.id)
    .eq("status", "active");

  const { data: openItems } = await db
    .from("action_items")
    .select("description")
    .eq("person_id", row.id)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(10);

  const openActionItems = (openItems || []).map((i) => i.description as string);

  const parts: string[] = [];
  if (row.summary) {
    parts.push(
      `Here is what you already know about this person from previous conversations:\n${row.summary}\n\nUse this naturally — don't recite it back at them. If it's still accurate, build on it. If something seems to have changed, ask rather than assume.`
    );
  }
  if (openActionItems.length > 0) {
    parts.push(
      `Open items from before that haven't been closed out:\n${openActionItems
        .map((i) => `- ${i}`)
        .join("\n")}\n\nBring these up if it's natural — "how did X go?" — don't run through them as a checklist.`
    );
  }

  // Optional: FKAIOS Brain context for this person's company. Unconfigured
  // or unreachable -> "" -> no-op, same degrade-independently pattern as
  // every other memory layer above.
  if (company?.brandName) {
    try {
      const brainContext = await getFkaiosBrainContext(company.brandName);
      if (brainContext) parts.push(brainContext);
    } catch {
      // getFkaiosBrainContext already catches internally; this is defense
      // in depth so a future change there still can't break memory.
    }
  }

  return {
    personId: row.id,
    isConfigured: true,
    isReturning: Boolean(row.summary),
    factCount: count || 0,
    openActionItems,
    company,
    contextForPrompt: parts.join("\n\n"),
  };
}

/**
 * V7: attaches a person to a company (create-a-company and join-by-id
 * both funnel through this). Returns the resolved branding so the
 * caller can theme immediately without a second round trip.
 */
export async function setPersonCompany(personId: string, companyId: string): Promise<CompanyBrand> {
  const db = getSupabaseAdmin();
  if (!db) throw new Error("Not configured");

  const { data: companyRow, error: companyErr } = await db
    .from("companies")
    .select("id, name, brand_name, primary_color, logo_url")
    .eq("id", companyId)
    .maybeSingle();

  if (companyErr) throw companyErr;
  if (!companyRow) throw new Error("No company with that id");

  const { error } = await db.from("people").update({ company_id: companyId }).eq("id", personId);
  if (error) throw error;

  return {
    id: companyRow.id,
    name: companyRow.name,
    brandName: companyRow.brand_name,
    primaryColor: companyRow.primary_color,
    logoUrl: companyRow.logo_url,
  };
}

export async function startConversation(personId: string): Promise<string | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const { data, error } = await db
    .from("conversations")
    .insert({ person_id: personId })
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

/**
 * Called when a call ends. Saves the transcript, then asks a text model
 * to pull durable facts, action items, and (where applicable) a business
 * assessment out of it. Best-effort throughout: a failure here never
 * surfaces to the voice UI, and the transcript is saved before any of
 * the extraction is attempted.
 */
export async function endConversationAndExtract(opts: {
  personId: string;
  conversationId: string;
  transcript: TranscriptTurn[];
  apiKey: string;
  model: string;
}): Promise<{
  saved: boolean;
  factsExtracted: number;
  actionItemsExtracted: number;
  assessmentRecorded: boolean;
  agentActionProposed: boolean;
  reason?: string;
}> {
  const db = getSupabaseAdmin();
  const empty = {
    saved: false,
    factsExtracted: 0,
    actionItemsExtracted: 0,
    assessmentRecorded: false,
    agentActionProposed: false,
  };
  if (!db) return { ...empty, reason: "memory not configured" };

  if (opts.transcript.length === 0) {
    await db
      .from("conversations")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", opts.conversationId);
    return { ...empty, saved: true, reason: "empty transcript" };
  }

  await db
    .from("conversations")
    .update({ ended_at: new Date().toISOString(), transcript: opts.transcript })
    .eq("id", opts.conversationId);

  const { data: person } = await db
    .from("people")
    .select("summary")
    .eq("id", opts.personId)
    .maybeSingle();

  const transcriptText = opts.transcript
    .map((t) => `${t.role === "user" ? "Them" : "Rajeev"}: ${t.text}`)
    .join("\n");

  const input = `You are maintaining a memory profile for a person who just finished a voice conversation with Rajeev, an AI thinking partner following the FK methodology (converting founder-dependent businesses into scalable, controlled, AI-assisted operating systems).

Existing summary of this person (may be empty if this is the first conversation):
${person?.summary || "(none yet)"}

Transcript of the conversation that just ended:
${transcriptText}

1. Extract durable facts worth remembering long-term: identity, business, goals, decisions, projects, real constraints, clear preferences. Give each fact a short stable fact_key describing its topic (e.g. "primary_business", "2026_revenue_target") so a later update to the same topic can replace it instead of duplicating it. Do not extract small talk or anything Rajeev said on his own.

2. Write an updated summary: a compact paragraph (under 150 words) capturing who this person is and where things stand, so reading it before the next conversation lets Rajeev pick up naturally. Merge with the existing summary; drop what's now clearly outdated.

3. Extract any concrete action items, commitments, or next steps that came out of the conversation — things the person or Rajeev said they'd do. If a project or business name was mentioned in connection with one, include it as project_hint.

4. If the conversation covered enough about the person's business to responsibly score it, provide a business assessment across the seven dimensions (0-100 each, higher always better, including founder_independence). If it didn't come up in enough depth, set applicable to false.`;

  try {
    const result = await callStructured<{
      facts: { category: string; fact_key: string; content: string }[];
      updated_summary: string;
      action_items: { description: string; project_hint: string | null }[];
      assessment: { applicable: boolean } & AssessmentScores;
    }>({
      apiKey: opts.apiKey,
      model: opts.model,
      input,
      schemaName: "memory_extraction",
      schema: EXTRACTION_SCHEMA,
    });

    // Facts: supersede same fact_key instead of appending beside it.
    for (const f of result.facts) {
      await db
        .from("memory_facts")
        .update({ status: "superseded" })
        .eq("person_id", opts.personId)
        .eq("fact_key", f.fact_key)
        .eq("status", "active");

      await db.from("memory_facts").insert({
        person_id: opts.personId,
        conversation_id: opts.conversationId,
        category: f.category,
        fact_key: f.fact_key,
        content: f.content,
      });
    }

    await db
      .from("people")
      .update({ summary: result.updated_summary, last_seen_at: new Date().toISOString() })
      .eq("id", opts.personId);

    // Action items: match to an existing active project by name if a
    // hint was given, otherwise create one. Simple exact-name match —
    // fuzzy project matching is a real gap, not a hidden one.
    let actionItemsExtracted = 0;
    for (const item of result.action_items) {
      let projectId: string | null = null;
      if (item.project_hint) {
        const { data: existingProject } = await db
          .from("projects")
          .select("id")
          .eq("person_id", opts.personId)
          .eq("name", item.project_hint)
          .eq("status", "active")
          .maybeSingle();

        if (existingProject) {
          projectId = existingProject.id as string;
        } else {
          const { data: newProject } = await db
            .from("projects")
            .insert({ person_id: opts.personId, name: item.project_hint })
            .select("id")
            .single();
          projectId = newProject?.id as string | null;
        }
      }

      await db.from("action_items").insert({
        person_id: opts.personId,
        project_id: projectId,
        conversation_id: opts.conversationId,
        description: item.description,
      });
      actionItemsExtracted++;
    }

    // Business assessment + the one live agent trigger it can produce.
    let assessmentRecorded = false;
    let agentActionProposed = false;
    if (result.assessment.applicable) {
      const scores: AssessmentScores = {
        commercial_attractiveness: result.assessment.commercial_attractiveness,
        operational_organization: result.assessment.operational_organization,
        differentiation: result.assessment.differentiation,
        financial_clarity: result.assessment.financial_clarity,
        systemization: result.assessment.systemization,
        founder_independence: result.assessment.founder_independence,
        technology_readiness: result.assessment.technology_readiness,
      };
      const overall = computeOverallScore(scores);
      const tier = computeTier(overall);

      await db.from("business_assessments").insert({
        person_id: opts.personId,
        conversation_id: opts.conversationId,
        ...scores,
        overall_score: overall,
        tier,
      });
      assessmentRecorded = true;

      const proposedId = await maybeProposeFromAssessment({ personId: opts.personId, scores });
      agentActionProposed = Boolean(proposedId);
    }

    return {
      saved: true,
      factsExtracted: result.facts.length,
      actionItemsExtracted,
      assessmentRecorded,
      agentActionProposed,
    };
  } catch (err) {
    // Transcript is already saved above — losing extraction loses this
    // session's new memory/items/assessment, not the conversation record.
    return { ...empty, saved: true, reason: String(err) };
  }
}

export async function getMemorySnapshot(personId: string) {
  const db = getSupabaseAdmin();
  if (!db) return { configured: false, isReturning: false, factCount: 0, openActionItems: 0 };

  const { data: person } = await db
    .from("people")
    .select("summary")
    .eq("id", personId)
    .maybeSingle();

  const { count: factCount } = await db
    .from("memory_facts")
    .select("id", { count: "exact", head: true })
    .eq("person_id", personId)
    .eq("status", "active");

  const { count: openActionItems } = await db
    .from("action_items")
    .select("id", { count: "exact", head: true })
    .eq("person_id", personId)
    .eq("status", "open");

  return {
    configured: true,
    isReturning: Boolean(person?.summary),
    factCount: factCount || 0,
    openActionItems: openActionItems || 0,
  };
}
