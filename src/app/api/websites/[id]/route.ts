import { apiHandlers } from "@/lib/api/routes";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return apiHandlers.updateWebsite(request, (await params).id);
}

export async function DELETE(_request: Request, { params }: Params) {
  return apiHandlers.removeWebsite((await params).id);
}
