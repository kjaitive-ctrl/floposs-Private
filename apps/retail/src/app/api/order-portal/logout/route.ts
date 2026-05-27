import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";

export async function POST() {
  const supabase = await getSupabaseRouteClient();
  await supabase.auth.signOut();
  return NextResponse.json({ success: true });
}
