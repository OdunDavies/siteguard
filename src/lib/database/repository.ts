import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { ApiContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";
import type { HealthCheck, Incident, Website } from "@/types/domain";
import type { z } from "zod";
import type { websiteRegistrationSchema, websiteUpdateSchema } from "@/lib/validation/website";
import { parseWebsiteUrl } from "@/lib/validation/website";

export type WebsiteCreate = z.output<typeof websiteRegistrationSchema>;
export type WebsiteUpdate = z.output<typeof websiteUpdateSchema>;

function databaseError(error: PostgrestError): never {
  if (error.code === "23505") throw new ApiError(409, "CONFLICT", "A conflicting record exists");
  throw new ApiError(500, "DATABASE_ERROR", "Database request failed");
}

export async function requireOwnedWebsite(ctx: ApiContext, id: string): Promise<Website> {
  const { data, error } = await ctx.supabase.from("websites").select("*")
    .eq("id", id).eq("owner_user_id", ctx.userId).is("deleted_at", null).maybeSingle();
  if (error) databaseError(error);
  if (!data) throw new ApiError(404, "NOT_FOUND", "Website not found");
  return data as Website;
}

export const siteRepository = {
  async list(ctx: ApiContext): Promise<Website[]> {
    const { data, error } = await ctx.supabase.from("websites").select("*")
      .eq("owner_user_id", ctx.userId).is("deleted_at", null).order("created_at", { ascending: false });
    if (error) databaseError(error);
    return data as Website[];
  },

  async create(ctx: ApiContext, input: WebsiteCreate, getWorker: () => SupabaseClient): Promise<Website> {
    const parsed = parseWebsiteUrl(input.url);
    if (!parsed) throw new ApiError(400, "VALIDATION_ERROR", "Invalid website URL");
    const { data, error } = await getWorker().from("websites").insert({
      owner_user_id: ctx.userId,
      name: input.name,
      url: parsed.url,
      normalized_host: parsed.host,
      monitor_interval_seconds: input.monitor_interval_seconds,
      failure_threshold: input.failure_threshold,
      recovery_threshold: input.recovery_threshold,
      is_enabled: input.is_enabled,
    }).select("*").single();
    if (error) databaseError(error);
    return data as Website;
  },

  async update(ctx: ApiContext, id: string, input: WebsiteUpdate, getWorker: () => SupabaseClient): Promise<Website> {
    await requireOwnedWebsite(ctx, id);
    const { data, error } = await getWorker().from("websites").update(input)
      .eq("id", id).eq("owner_user_id", ctx.userId).is("deleted_at", null).select("*").maybeSingle();
    if (error) databaseError(error);
    if (!data) throw new ApiError(404, "NOT_FOUND", "Website not found");
    return data as Website;
  },

  async remove(ctx: ApiContext, id: string, getWorker: () => SupabaseClient): Promise<void> {
    await requireOwnedWebsite(ctx, id);
    // Count the scoped worker update; soft-deleted rows are hidden from user reads.
    const { count, error } = await getWorker().from("websites")
      .update({ is_enabled: false, deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", id).eq("owner_user_id", ctx.userId).is("deleted_at", null);
    if (error) databaseError(error);
    if (count !== 1) throw new ApiError(404, "NOT_FOUND", "Website not found");
  },

  async checks(ctx: ApiContext, websiteId: string, limit: number): Promise<HealthCheck[]> {
    await requireOwnedWebsite(ctx, websiteId);
    const { data, error } = await ctx.supabase.from("health_checks").select("*")
      .eq("website_id", websiteId).order("checked_at", { ascending: false }).limit(limit);
    if (error) databaseError(error);
    return data as HealthCheck[];
  },

  async incidents(ctx: ApiContext, websiteId: string | undefined, limit: number): Promise<Incident[]> {
    if (websiteId) await requireOwnedWebsite(ctx, websiteId);
    let query = ctx.supabase.from("incidents").select("*").order("started_at", { ascending: false }).limit(limit);
    if (websiteId) query = query.eq("website_id", websiteId);
    const { data, error } = await query;
    if (error) databaseError(error);
    return data as Incident[];
  },

  async activeIncidents(ctx: ApiContext): Promise<Incident[]> {
    const { data, error } = await ctx.supabase.from("incidents").select("*")
      .in("status", ["open", "recovering"])
      .order("started_at", { ascending: false }).limit(100);
    if (error) databaseError(error);
    return data as Incident[];
  },

  async summary(ctx: ApiContext, websiteId: string) {
    await requireOwnedWebsite(ctx, websiteId);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [all, healthy, latest, active] = await Promise.all([
      ctx.supabase.from("health_checks").select("id", { count: "exact", head: true })
        .eq("website_id", websiteId).gte("checked_at", since),
      ctx.supabase.from("health_checks").select("id", { count: "exact", head: true })
        .eq("website_id", websiteId).eq("status", "healthy").gte("checked_at", since),
      ctx.supabase.from("health_checks").select("*").eq("website_id", websiteId)
        .order("checked_at", { ascending: false }).limit(1).maybeSingle(),
      ctx.supabase.from("incidents").select("*").eq("website_id", websiteId)
        .in("status", ["open", "recovering"]).maybeSingle(),
    ]);
    if (all.error) databaseError(all.error);
    if (healthy.error) databaseError(healthy.error);
    if (latest.error) databaseError(latest.error);
    if (active.error) databaseError(active.error);
    const total = all.count ?? 0;
    return {
      website_id: websiteId,
      window_hours: 24,
      total_checks: total,
      healthy_checks: healthy.count ?? 0,
      availability_percent: total ? Math.round(((healthy.count ?? 0) / total) * 10000) / 100 : null,
      latest_check: latest.data as HealthCheck | null,
      active_incident: active.data as Incident | null,
    };
  },
};
