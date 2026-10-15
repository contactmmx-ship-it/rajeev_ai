import { NextRequest, NextResponse } from "next/server";
import { EMBED_PROJECTS } from "@/lib/embedProjects.ts";
import {
  buildEmbedInstructions,
  corsHeaders,
  createRateLimiter,
  findProject,
  isOriginAllowed,
  isOriginKnown,
  parseExtraOrigins,
} from "@/lib/embed.ts";
import { METHODOLOGY_BRIEFING } from "@/lib/methodology";

// Issues a short-lived OpenAI Realtime key so a project's page can talk to
// Rajeev AI directly. The real OPENAI_API_KEY never leaves this server.
//
// Cost controls:
//   RAJEEV_EMBED_ENABLED must be "true" or no session is issued at all.
//   RAJEEV_EMBED_MAX_PER_HOUR caps sessions per visitor IP (default 20).

const maxPerHour = Math.max(1, Number(process.env.RAJEEV_EMBED_MAX_PER_HOUR) || 20);
const allow = createRateLimiter(maxPerHour, 60 * 60 * 1000);

function selfOrigin(req: NextRequest): string {
  return new URL(req.url).origin;
}

function json(body: unknown, status: number, origin?: string | null) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return NextResponse.json(body, { status, headers });
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin");
  const extra = parseExtraOrigins(process.env.RAJEEV_EMBED_EXTRA_ORIGINS);
  if (!origin || !isOriginKnown(EMBED_PROJECTS, origin, extra, selfOrigin(req))) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const extra = parseExtraOrigins(process.env.RAJEEV_EMBED_EXTRA_ORIGINS);

  let body: { project?: unknown; pageContext?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send JSON: { project, pageContext? }" }, 400);
  }

  const project = findProject(EMBED_PROJECTS, body.project);
  if (!project) return json({ error: "Unknown project" }, 404);

  if (!isOriginAllowed(project, origin, extra, selfOrigin(req))) {
    return json({ error: "This website is not allowed to use Rajeev AI for this project" }, 403);
  }
  const cors = origin as string;

  if (process.env.RAJEEV_EMBED_ENABLED !== "true") {
    return json({ error: "Rajeev AI is switched off for now." }, 503, cors);
  }

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (!allow(`${project.key}|${ip}`)) {
    return json({ error: "Too many Rajeev AI sessions. Try again in an hour." }, 429, cors);
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: "Rajeev AI is not set up yet (no OpenAI key on the server)." }, 500, cors);

  const instructions = buildEmbedInstructions({
    project,
    methodology: METHODOLOGY_BRIEFING,
    pageContext: body.pageContext,
  });

  let r: Response;
  try {
    r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          instructions,
          audio: {
            input: {
              transcription: { model: process.env.TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { voice: "marin" },
          },
        },
      }),
    });
  } catch {
    return json({ error: "Could not reach the voice service." }, 502, cors);
  }

  let data: any = null;
  try {
    data = await r.json();
  } catch {
    // handled below
  }
  if (!r.ok || !data?.value) {
    return json({ error: "The voice service refused the session." }, 502, cors);
  }

  // Return only what the browser needs: the short-lived key and its expiry.
  return json(
    { value: data.value, expires_at: data.expires_at ?? null, project: { key: project.key, name: project.name } },
    200,
    cors
  );
}
