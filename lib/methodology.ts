/**
 * V3 — Rajeev Methodology / V4 — Business Advisor
 *
 * This is not generic business-coaching content. These seven dimensions
 * and tier thresholds are the FK Expansion Readiness Score already in
 * use elsewhere (e.g. the Perfume Wala assessment scored 73 →
 * "Expansion Ready"). Encoding the real framework here rather than
 * inventing a plausible-sounding one.
 */

export const ASSESSMENT_DIMENSIONS = [
  "commercial_attractiveness",
  "operational_organization",
  "differentiation",
  "financial_clarity",
  "systemization",
  "founder_independence",
  "technology_readiness",
] as const;

export type AssessmentDimension = (typeof ASSESSMENT_DIMENSIONS)[number];

export type AssessmentScores = Record<AssessmentDimension, number>;

export type Tier = "Founder-Dependent" | "Needs Systemization" | "Expansion Ready";

/**
 * Reference summary of the framework, meant to be dropped into the
 * realtime session's instructions so Rajeev reasons with the same
 * structure a human FK advisor would — without turning the conversation
 * into a checklist read-out.
 */
export const METHODOLOGY_BRIEFING = `You carry the FK methodology: the core thesis is converting founder-dependent businesses into scalable, controlled, measurable, AI-assisted operating systems — not just "helping them franchise."

When someone describes their business at any length, you are implicitly forming a read across seven dimensions, each independent of the others: commercial attractiveness, operational organization, differentiation, financial-model clarity, systemization (does it run without them?), founder independence (could someone else run a shift/branch today?), and technology readiness. You don't recite these at the person or turn the call into an audit. You let them surface naturally in how you question and reflect back what you're hearing.

Where controls matter (a business handling cash, inventory, or billing), the FK control philosophy is a reconciliation chain: Product → Bill → Price → Money → Movement, with any mismatch escalating through Incident → Alert → Investigation → Audit Trail. Leakage, not lack of customers, is usually the real risk in an unsystemized business.`;

export function computeOverallScore(scores: AssessmentScores): number {
  const values = ASSESSMENT_DIMENSIONS.map((d) => scores[d]);
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round(sum / values.length);
}

/**
 * Tier thresholds calibrated to the one real data point on file: 73
 * scored "Expansion Ready." Set the boundary just under that, and split
 * the remaining range so "Founder-Dependent" reads as a genuine warning
 * rather than the default bucket.
 */
export function computeTier(overallScore: number): Tier {
  if (overallScore >= 70) return "Expansion Ready";
  if (overallScore >= 40) return "Needs Systemization";
  return "Founder-Dependent";
}
