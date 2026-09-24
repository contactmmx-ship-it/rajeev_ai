import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const personId = req.nextUrl.searchParams.get("personId");
  if (!personId) return NextResponse.json({ error: "personId is required" }, { status: 400 });

  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ configured: false, projects: [], actionItems: [] });

  const [{ data: projects, error: projErr }, { data: actionItems, error: itemErr }] = await Promise.all([
    db.from("projects").select("*").eq("person_id", personId).order("created_at", { ascending: false }),
    db
      .from("action_items")
      .select("*")
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (projErr || itemErr) {
    return NextResponse.json({ configured: true, error: String(projErr || itemErr) }, { status: 500 });
  }

  return NextResponse.json({ configured: true, projects: projects || [], actionItems: actionItems || [] });
}

export async function PATCH(req: NextRequest) {
  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: "Not configured" }, { status: 500 });

  let body: { actionItemId?: string; status?: "open" | "done" | "dropped" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.actionItemId || !body.status) {
    return NextResponse.json({ error: "actionItemId and status are required" }, { status: 400 });
  }

  const { error } = await db
    .from("action_items")
    .update({ status: body.status })
    .eq("id", body.actionItemId);

  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ updated: true });
}
