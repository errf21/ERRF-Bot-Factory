import type { Env, BotConfig } from "./types";
import { defaultConfig } from "./types";
import { one } from "./core";
export async function config(env: Env, bot: string): Promise<BotConfig> {
  const r = await one<{ config: string }>(
    env,
    "SELECT config FROM bot_configs WHERE bot_id=?",
    bot,
  );
  return { ...defaultConfig, ...JSON.parse(r?.config ?? "{}") };
}
