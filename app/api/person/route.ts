import { NextRequest, NextResponse } from "next/server";
import { getOrCreatePerson, setPersonCompany } from "@/lib/memory";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const authUserId = req.nextUrl.searchParams.get("authUserId");
  if (!authUserId) return NextResponse.json({ error: "authUserId is required" }, { status: 400 });

  try {
    const memory = await getOrCreatePerson(authUserId);
    return NextResponse.json({
      personId: memory.personId,
      isConfigured: memory.isConfigured,
      isReturning: memory.isReturning,
      factCount: memory.factCount,
      openActionItemCount: memory.openActionItems.length,
      company: memory.company,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * V7: attach a person to a company — either by creating one (name only)
 * or by joining an existing one with its id. This is the "join by id"
 * half of white-labeling; the invite-link/team-management niceties on
 * top of it are a real next step, not part of what V7 asked for.
 */
export async function PATCH(req: NextRequest) {
  let body: { personId?: string; companyId?: string; createCompanyName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.personId) return NextResponse.json({ error: "personId is required" }, { status: 400 });
  if (!body.companyId && !body.createCompanyName) {
    return NextResponse.json({ error: "companyId or createCompanyName is required" }, { status: 400 });
  }

  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: "Not configured" }, { status: 500 });

  try {
    let companyId = body.companyId;

    if (!companyId && body.createCompanyName) {
      const { data: newCompany, error } = await db
        .from("companies")
        .insert({ name: body.createCompanyName, brand_name: body.createCompanyName })
        .select("id")
        .single();
      if (error) throw error;
      companyId = newCompany.id;
    }

    const company = await setPersonCompany(body.personId, companyId as string);
    return NextResponse.json({ company });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
