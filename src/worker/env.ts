import type { ProviderId } from "../shared/types";
import { PROVIDER_IDS } from "../shared/types";

/**
 * Bindings and variables available to the Worker.
 * Secrets are set in the Cloudflare dashboard (Settings -> Variables and Secrets)
 * or with `npx wrangler secret put NAME`. For local development put them in `.dev.vars`.
 */
export interface Env {
  DB: D1Database;
  AI?: Ai;
  ASSETS?: Fetcher;

  // --- Authentication ---
  /** Google sign-in (anyone can create an account unless sign-ups are closed in the admin panel). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** GitHub sign-in: administrators only. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated administrator emails (matched against the verified sign-in email). */
  ADMIN_EMAILS?: string;
  /** Comma-separated administrator GitHub usernames (the only accounts allowed to use GitHub sign-in). */
  ADMIN_GITHUB_USERS?: string;
  /** Older name for ADMIN_GITHUB_USERS, still honoured when ADMIN_GITHUB_USERS is not set. */
  ALLOWED_GITHUB_USERS?: string;
  /** Messages per user per day unless the admin sets another value in the admin panel (default 30). */
  DEFAULT_DAILY_LIMIT?: string;

  // --- Free AI providers (set at least one, or rely on Workers AI) ---
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  MISTRAL_API_KEY?: string;

  // --- Live information (optional) ---
  /** Tavily web search (free plan: 1,000 credits/month). Without it, web search is simply not offered. */
  TAVILY_API_KEY?: string;

  // --- Optional tuning ---
  APP_NAME?: string;
  PROVIDER_ORDER?: string;
  GROQ_MODEL?: string;
  GEMINI_MODEL?: string;
  OPENROUTER_MODEL?: string;
  MISTRAL_MODEL?: string;
  WORKERS_AI_MODEL?: string;
  WORKERS_AI_MODELS?: string;
  WORKERS_AI_ENABLED?: string;
  MAX_CONTEXT_CHARS?: string;
  MAX_OUTPUT_TOKENS?: string;
  CHAT_RATE_LIMIT_PER_MINUTE?: string;
  SESSION_TTL_DAYS?: string;

  // --- Local development & testing only ---
  /** Enables POST /api/auth/dev-login, and ONLY for requests to localhost / 127.0.0.1. */
  DEV_LOGIN?: string;
  GROQ_BASE_URL?: string;
  GEMINI_BASE_URL?: string;
  OPENROUTER_BASE_URL?: string;
  MISTRAL_BASE_URL?: string;
  GITHUB_OAUTH_BASE_URL?: string;
  GITHUB_API_BASE_URL?: string;
  GOOGLE_OAUTH_BASE_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_USERINFO_URL?: string;
}

export interface AppConfig {
  appName: string;
  providerOrder: ProviderId[];
  /** Lower-case administrator GitHub usernames. */
  adminGithubUsers: Set<string>;
  /** Lower-case administrator emails. */
  adminEmails: Set<string>;
  githubLoginEnabled: boolean;
  googleLoginEnabled: boolean;
  defaultDailyLimit: number;
  devLogin: boolean;
  maxContextChars: number;
  maxOutputTokens: number;
  chatRateLimitPerMinute: number;
  sessionTtlMs: number;
  workersAiEnabled: boolean;
  githubOAuthBaseUrl: string;
  githubApiBaseUrl: string;
  googleOAuthBaseUrl: string;
  googleTokenUrl: string;
  googleUserinfoUrl: string;
}

export const DEFAULT_PROVIDER_ORDER: ProviderId[] = ["groq", "gemini", "openrouter", "mistral", "workers-ai"];

function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function boolVar(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function parseProviderOrder(value: string | undefined): ProviderId[] {
  if (!value?.trim()) return [...DEFAULT_PROVIDER_ORDER];
  const seen = new Set<ProviderId>();
  for (const raw of value.split(",")) {
    const id = raw.trim().toLowerCase() as ProviderId;
    if (PROVIDER_IDS.includes(id)) seen.add(id);
  }
  return seen.size > 0 ? [...seen] : [...DEFAULT_PROVIDER_ORDER];
}

const csvSet = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const configCache = new WeakMap<object, AppConfig>();

export function getConfig(env: Env): AppConfig {
  const cached = configCache.get(env);
  if (cached) return cached;
  const adminGithubUsers = csvSet(env.ADMIN_GITHUB_USERS);
  const config: AppConfig = {
    appName: env.APP_NAME?.trim() || "Assistant",
    providerOrder: parseProviderOrder(env.PROVIDER_ORDER),
    adminGithubUsers: adminGithubUsers.size > 0 ? adminGithubUsers : csvSet(env.ALLOWED_GITHUB_USERS),
    adminEmails: csvSet(env.ADMIN_EMAILS),
    githubLoginEnabled: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    googleLoginEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    defaultDailyLimit: intVar(env.DEFAULT_DAILY_LIMIT, 30, 0, 100_000),
    devLogin: boolVar(env.DEV_LOGIN, false),
    maxContextChars: intVar(env.MAX_CONTEXT_CHARS, 16_000, 2_000, 400_000),
    maxOutputTokens: intVar(env.MAX_OUTPUT_TOKENS, 2_048, 128, 32_768),
    chatRateLimitPerMinute: intVar(env.CHAT_RATE_LIMIT_PER_MINUTE, 20, 1, 1_000),
    sessionTtlMs: intVar(env.SESSION_TTL_DAYS, 30, 1, 365) * 24 * 60 * 60 * 1000,
    workersAiEnabled: boolVar(env.WORKERS_AI_ENABLED, true) && Boolean(env.AI),
    githubOAuthBaseUrl: (env.GITHUB_OAUTH_BASE_URL || "https://github.com").replace(/\/+$/, ""),
    githubApiBaseUrl: (env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/+$/, ""),
    googleOAuthBaseUrl: (env.GOOGLE_OAUTH_BASE_URL || "https://accounts.google.com").replace(/\/+$/, ""),
    googleTokenUrl: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    googleUserinfoUrl: env.GOOGLE_USERINFO_URL || "https://openidconnect.googleapis.com/v1/userinfo",
  };
  configCache.set(env, config);
  return config;
}
