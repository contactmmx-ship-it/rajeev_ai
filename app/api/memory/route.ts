import { NextRequest, NextResponse } from "next/server";
import { getMemorySnapshot } from "@/lib/memory";

export async function GET(req: NextRequest) {
  const personId = req.nextUrl.searchParams.get("personId");
  if (!personId) return NextResponse.json({ error: "personId is required" }, { status: 400 });

  try {
    const snapshot = await getMemorySnapshot(personId);
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json(
      { configured: false, isReturning: false, factCount: 0, error: String(err) },
      { status: 200 }
    );
  }
}
