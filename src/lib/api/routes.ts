import "server-only";

import { requireApiContext } from "./context";
import { createApiHandlers } from "./handlers";
import { siteRepository } from "@/lib/database/repository";
import { createMonitoringWorkerClient } from "@/lib/database/worker";

export const apiHandlers = createApiHandlers(requireApiContext, siteRepository, createMonitoringWorkerClient);
