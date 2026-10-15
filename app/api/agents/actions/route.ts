import { NextRequest, NextResponse } from "next/server";
import { listActions } from "@/lib/agents";

export async function GET(req: NextRequest) {
  const personId = req.nextUrl.searchParams.get("personId");
  const status = req.nextUrl.searchParams.get("status") || undefined;
  if (!personId) return NextResponse.json({ error: "personId is required" }, { status: 400 });

  try {
    const actions = await listActions(personId, status);
    return NextResponse.json({ configured: actions !== null, actions: actions || [] });
  } catch (err) {
    return NextResponse.json({ configured: false, actions: [], error: String(err) }, { status: 200 });
  }
}
