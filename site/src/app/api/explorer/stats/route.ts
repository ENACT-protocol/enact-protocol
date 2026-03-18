import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const sb = createClient(url, key);
    const { data, error } = await sb.rpc('get_daily_stats');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json(data ?? []);
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown' }, { status: 500 });
  }
}
