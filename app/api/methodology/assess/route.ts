import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const personId = req.nextUrl.searchParams.get("personId");
  if (!personId) return NextResponse.json({ error: "personId is required" }, { status: 400 });

  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ configured: false, latest: null, history: [] });

  const { data, error } = await db
    .from("business_assessments")
    .select("*")
    .eq("person_id", personId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return NextResponse.json({ configured: true, error: String(error) }, { status: 500 });

  return NextResponse.json({
    configured: true,
    latest: data?.[0] || null,
    history: data || [],
  });
}
