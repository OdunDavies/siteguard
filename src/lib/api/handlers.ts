import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleApi, readJson } from "./errors";
import type { ApiContext } from "./context";
import type { siteRepository } from "@/lib/database/repository";
import { uuidSchema } from "@/lib/validation/incident";
import { websiteRegistrationSchema, websiteUpdateSchema } from "@/lib/validation/website";

const limitSchema = z.coerce.number().int().min(1).max(100).default(50);

type Repository = typeof siteRepository;
type GetContext = () => Promise<ApiContext>;
type GetWorker = () => SupabaseClient;

export function createApiHandlers(getContext: GetContext, repository: Repository, getWorker: GetWorker) {
  return {
    listWebsites: () => handleApi(async () => {
      const ctx = await getContext();
      return { data: await repository.list(ctx) };
    }),

    registerWebsite: (request: Request) => handleApi(async () => {
      const ctx = await getContext();
      const input = websiteRegistrationSchema.parse(await readJson(request));
      return { data: await repository.create(ctx, input, getWorker), status: 201 };
    }),

    updateWebsite: (request: Request, rawId: string) => handleApi(async () => {
      const ctx = await getContext();
      const id = uuidSchema.parse(rawId);
      const input = websiteUpdateSchema.parse(await readJson(request));
      return { data: await repository.update(ctx, id, input, getWorker) };
    }),

    removeWebsite: (rawId: string) => handleApi(async () => {
      const ctx = await getContext();
      const id = uuidSchema.parse(rawId);
      await repository.remove(ctx, id, getWorker);
      return { data: { id, removed: true } };
    }),

    monitoringHistory: (request: Request, rawId: string) => handleApi(async () => {
      const ctx = await getContext();
      const id = uuidSchema.parse(rawId);
      const limit = limitSchema.parse(new URL(request.url).searchParams.get("limit") ?? undefined);
      return { data: await repository.checks(ctx, id, limit) };
    }),

    listIncidents: (request: Request) => handleApi(async () => {
      const ctx = await getContext();
      const params = new URL(request.url).searchParams;
      const websiteId = params.get("websiteId");
      const id = websiteId === null ? undefined : uuidSchema.parse(websiteId);
      const limit = limitSchema.parse(params.get("limit") ?? undefined);
      return { data: await repository.incidents(ctx, id, limit) };
    }),

    activeIncidents: () => handleApi(async () => {
      const ctx = await getContext();
      return { data: await repository.activeIncidents(ctx) };
    }),

    websiteSummary: (rawId: string) => handleApi(async () => {
      const ctx = await getContext();
      const id = uuidSchema.parse(rawId);
      return { data: await repository.summary(ctx, id) };
    }),
  };
}
