import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // octocat is the administrator; every other dev-login name is a regular user.
            ADMIN_GITHUB_USERS: "octocat",
            ADMIN_EMAILS: "boss@example.com",
            DEV_LOGIN: "true",
            WORKERS_AI_ENABLED: "false",
            // Tests never use real keys, even when .dev.vars has them for local testing (tests set their own fakes).
            GROQ_API_KEY: "",
            GEMINI_API_KEY: "",
            OPENROUTER_API_KEY: "",
            MISTRAL_API_KEY: "",
            TAVILY_API_KEY: "",
          },
        },
      }),
    ],
    test: {
      include: ["tests/**/*.test.ts"],
      setupFiles: ["./tests/setup.ts"],
    },
  };
});
