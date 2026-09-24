import { NextRequest, NextResponse } from "next/server";
import { executeAction } from "@/lib/agents";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const result = await executeAction(id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ executed: false, reason: String(err) }, { status: 500 });
  }
}
