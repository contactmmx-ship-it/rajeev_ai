import { NextRequest, NextResponse } from "next/server";
import { getOrCreatePerson, startConversation } from "@/lib/memory";
import { METHODOLOGY_BRIEFING } from "@/lib/methodology";

function baseInstructions(brandName: string) {
  return `You are ${brandName}. Speak naturally and warmly.
Use Hinglish when the user does. Do not rush into generic advice.
Understand the person's WHY, goals, resources, fears, strengths and constraints.
Ask one useful question when needed, challenge assumptions respectfully,
and move toward practical action. Keep spoken answers conversational and concise.`;
}

export async function POST(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 500 });

  let body: { authUserId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // No body sent — fine, treat as unauthenticated (memory just won't attach).
  }

  let memory;
  try {
    memory = await getOrCreatePerson(body.authUserId);
  } catch {
    // Memory is progressive enhancement — never block voice on it.
    memory = {
      personId: body.authUserId || crypto.randomUUID(),
      isConfigured: false,
      isReturning: false,
      factCount: 0,
      openActionItems: [] as string[],
      company: null,
      contextForPrompt: "",
    };
  }

  const brandName = memory.company?.brandName || "Rajeev AI";
  const instructions = [baseInstructions(brandName), METHODOLOGY_BRIEFING, memory.contextForPrompt]
    .filter(Boolean)
    .join("\n\n");

  const transcriptionModel = process.env.TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";

  let r: Response;
  try {
    r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          instructions,
          audio: {
            input: {
              transcription: { model: transcriptionModel },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
                // The actual barge-in switch: lets the user cut Rajeev
                // off mid-sentence instead of waiting him out.
                interrupt_response: true,
              },
            },
            output: { voice: "marin" },
          },
        },
      }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not reach OpenAI Realtime API", detail: String(err) },
      { status: 502 }
    );
  }

  const raw = await r.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "OpenAI returned a non-JSON response", detail: raw.slice(0, 500) },
      { status: 502 }
    );
  }

  if (!r.ok) return NextResponse.json(data, { status: r.status });

  let conversationId: string | null = null;
  try {
    conversationId = await startConversation(memory.personId);
  } catch {
    // Conversation logging failing shouldn't block the call starting.
  }

  return NextResponse.json({
    ...data,
    personId: memory.personId,
    conversationId,
    isReturning: memory.isReturning,
    factCount: memory.factCount,
    openActionItemCount: memory.openActionItems.length,
    company: memory.company,
  });
}
