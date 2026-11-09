import type { SessionUser } from "./db/users";
import type { Env } from "./env";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    requestId: string;
  };
}
