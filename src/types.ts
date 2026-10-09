export interface Env {
  DB: D1Database;
  PUBLIC_BASE_URL: string;
  MASTER_KEYS: string;
  KEY_VERSION: string;
  FACTORY_BOT_TOKEN: string;
  FACTORY_WEBHOOK_SECRET: string;
  CENTRAL_ADMIN_IDS: string;
  PANEL_ALLOWED_HOSTS: string;
  FACTORY_OPEN_REGISTRATION?: string;
  BUILD_VERSION?: string;
}
export interface Bot {
  id: string;
  tenant_id: string;
  telegram_id: number;
  username: string;
  token_enc: string;
  webhook_secret_enc: string;
  state: string;
  error_code: string | null;
}
export interface Panel {
  id: string;
  bot_id: string;
  name: string;
  adapter: string;
  url_enc: string;
  credentials_enc: string;
  enabled: number;
  is_default: number;
}
export interface Service {
  id: string;
  bot_id: string;
  customer_id: number;
  panel_id: string;
  order_id: string;
  inbound_id: number;
  client_id: string;
  email: string;
  bytes: number;
  expires_at: number;
  state: string;
}
export interface Operation {
  id: string;
  bot_id: string;
  service_id: string;
  kind: "CREATE" | "UPDATE" | "REVOKE";
  payload: string;
  state: string;
  attempts: number;
  claim_id?: string;
  order_id?: string | null;
}
export interface Update {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    photo?: {
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }[];
    document?: {
      file_id: string;
      file_unique_id: string;
      mime_type?: string;
      file_size?: number;
      file_name?: string;
    };
  };
  callback_query?: {
    id: string;
    from: { id: number; is_bot?: boolean };
    data?: string;
    message?: { message_id: number; chat: { id: number; type: string } };
  };
}
export interface BotConfig {
  welcome: string;
  help: string;
  support: string;
  language: "fa" | "en";
  menu_buy: string;
  menu_services: string;
  sales_enabled: boolean;
  notifications_enabled: boolean;
  panel_selection: "choose" | "default";
}
export const defaultConfig: BotConfig = {
  welcome: "به ERRF خوش آمدید. برای خرید سرویس، پنل را انتخاب کنید.",
  help: "برای خرید /buy و برای سرویس‌های من /services را بزنید.",
  support: "پشتیبانی تنظیم نشده است.",
  language: "fa",
  menu_buy: "خرید سرویس",
  menu_services: "سرویس‌های من",
  sales_enabled: true,
  notifications_enabled: true,
  panel_selection: "choose",
};
