import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ configured: false, company: null });

  const { data, error } = await db.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (error) return NextResponse.json({ configured: true, error: String(error) }, { status: 500 });

  return NextResponse.json({ configured: true, company: data });
}

export async function POST(req: NextRequest) {
  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: "Not configured" }, { status: 500 });

  let body: { name?: string; brandName?: string; primaryColor?: string; logoUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const { data, error } = await db
    .from("companies")
    .insert({
      name: body.name,
      brand_name: body.brandName || "Rajeev AI",
      primary_color: body.primaryColor || "#c9a84c",
      logo_url: body.logoUrl || null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ company: data });
}
