import { NextRequest, NextResponse } from "next/server";
import { decideAction } from "@/lib/agents";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: { decision?: "approved" | "rejected"; decidedBy?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.decision !== "approved" && body.decision !== "rejected") {
    return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
  }

  try {
    await decideAction({
      actionId: id,
      decision: body.decision,
      decidedBy: body.decidedBy || "unknown",
    });
    return NextResponse.json({ decided: true });
  } catch (err) {
    return NextResponse.json({ decided: false, error: String(err) }, { status: 500 });
  }
}
