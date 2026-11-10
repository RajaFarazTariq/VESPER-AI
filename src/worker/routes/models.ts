import { Hono } from "hono";
import type { ModelsResponse, ProviderStatusDto } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { D1ProviderStateStore, getTodayUsage } from "../db/provider-state";
import { getConfig } from "../env";
import { getProviderModels } from "../llm/catalog";
import { getProviders } from "../llm/registry";
import { requireUser } from "../middleware/auth";

export const modelRoutes = new Hono<AppEnv>()
  .use(requireUser)

  /** Every provider with its live free model list, health and today's usage. */
  .get("/", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    const config = getConfig(c.env);
    const providers = getProviders(c.env);
    const [health, usage] = await Promise.all([new D1ProviderStateStore(c.env.DB).getHealth(), getTodayUsage(c.env.DB)]);
    const now = Date.now();
    // Provider error messages are for the administrator; users only need the model lists.
    const isAdmin = c.get("user").role === "admin";

    // Show providers in routing order, then any not listed in PROVIDER_ORDER.
    const ordered = [
      ...config.providerOrder.map((id) => providers.get(id)!).filter(Boolean),
      ...[...providers.values()].filter((p) => !config.providerOrder.includes(p.id)),
    ];

    const statuses = await Promise.all(
      ordered.map(async (provider): Promise<ProviderStatusDto> => {
        const configured = provider.isConfigured();
        const models = configured ? await getProviderModels(c.env.DB, provider, { refresh }) : [];
        let defaultModel: string | null = null;
        if (configured) defaultModel = await provider.defaultModel().catch(() => null);
        const state = health.get(provider.id);
        return {
          id: provider.id,
          label: provider.label,
          configured,
          defaultModel,
          models,
          cooldownUntil: state && state.cooldownUntil > now ? state.cooldownUntil : null,
          lastError: isAdmin ? (state?.lastError ?? null) : null,
          today: usage.get(provider.id) ?? { requests: 0, failures: 0 },
          freeTier: provider.freeTier,
          notes: provider.notes,
          signupUrl: provider.signupUrl,
        };
      }),
    );
    const body: ModelsResponse = { providers: statuses, order: config.providerOrder };
    return c.json(body);
  });
