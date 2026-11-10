import { handleVisits, readVisitEnv } from '@/lib/visits';

// Reads request headers and secrets, so it must never be prerendered.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleVisits(request, readVisitEnv(process.env));
}

export function POST(request: Request): Promise<Response> {
  return handleVisits(request, readVisitEnv(process.env));
}
