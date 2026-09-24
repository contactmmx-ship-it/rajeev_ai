import { NextRequest, NextResponse } from "next/server";
import { endConversationAndExtract, TranscriptTurn } from "@/lib/memory";

export async function POST(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 500 });

  let body: { personId?: string; conversationId?: string; transcript?: TranscriptTurn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.personId || !body.conversationId) {
    return NextResponse.json({ error: "personId and conversationId are required" }, { status: 400 });
  }

  const model = process.env.MEMORY_EXTRACTION_MODEL || "gpt-5-mini";

  try {
    const result = await endConversationAndExtract({
      personId: body.personId,
      conversationId: body.conversationId,
      transcript: body.transcript || [],
      apiKey: key,
      model,
    });
    return NextResponse.json(result);
  } catch (err) {
    // This is post-call bookkeeping — a failure here shouldn't read as a
    // broken product to the person who just finished talking to Rajeev.
    return NextResponse.json({ saved: false, factsExtracted: 0, reason: String(err) }, { status: 200 });
  }
}
