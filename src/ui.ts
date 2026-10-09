import type { Reply } from "./delivery";
export const reply = (text: string): Reply => ({ text });
export const buttons = (
  text: string,
  options: { text: string; callback_data: string }[][],
): Reply => ({ text, reply_markup: { inline_keyboard: options } });
export const money = (amount: number, currency: string) =>
  `${new Intl.NumberFormat("fa-IR").format(amount)} ${currency === "IRR" ? "ریال" : currency}`;
export const bytes = (n: number) => {
  if (n === 0) return "نامحدود";
  const units = ["بایت", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(4, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
  return `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(n / 1024 ** i)} ${units[i]}`;
};
export const date = (seconds: number) =>
  seconds > 0
    ? new Intl.DateTimeFormat("fa-IR", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Tehran",
      }).format(seconds * 1000)
    : "بدون انقضا";
export const state = (s: string) =>
  ({
    AWAITING_RECEIPT: "منتظر ارسال رسید",
    UNDER_REVIEW: "در انتظار بررسی مدیر",
    MORE_EVIDENCE: "نیازمند مدرک تکمیلی",
    APPROVED: "پرداخت با تأیید دستی مدیر",
    REJECTED: "پرداخت رد شد",
    UNCONFIGURED: "کارت مقصد تنظیم نشده",
    NOT_REQUIRED: "بدون نیاز به پرداخت",
    LEGACY: "رکورد نسخه قبلی",
    PROVISIONING: "در حال آماده‌سازی",
    FULFILLED: "تحویل شده",
    ACTIVE: "فعال",
    PENDING: "در صف",
    FAILED: "ناموفق؛ نیازمند بررسی",
    UNKNOWN: "نتیجه نامشخص؛ قابل بازیابی",
    CANCELLED: "لغو شده",
    REVOKED: "لغو سرویس",
    SUCCEEDED: "تأیید شده",
  })[s] ?? s;
export function errorText(code: string) {
  return (
    (
      {
        FORBIDDEN: "شما مجوز این اقدام را ندارید.",
        PANEL_NETWORK_UNCERTAIN:
          "ارتباط با پنل قطع شد؛ نتیجه باید بررسی شود. به پنل دیگری ارسال نشد.",
        PANEL_AUTH_FAILED:
          "ورود به پنل ناموفق بود؛ مدیر باید اعتبارنامه‌ها را بررسی کند.",
        PANEL_NOT_AVAILABLE: "پنل انتخاب‌شده غیرفعال یا در دسترس نیست.",
        ROUTED_PANEL_UNAVAILABLE:
          "پنل تعیین‌شده توسط قانون مسیریابی فعال نیست؛ جایگزینی خودکار انجام نشد.",
        PLAN_CHANGED_RECONFIRM:
          "مشخصات یا قیمت طرح تغییر کرده است. دوباره طرح و پنل را بررسی و تأیید کنید.",
        ORDER_NOT_ACCEPTING_EVIDENCE:
          "این سفارش اکنون رسید جدید نمی‌پذیرد. وضعیت سفارش را بررسی کنید.",
        SELECT_ORDER_BEFORE_RECEIPT:
          "ابتدا سفارش را انتخاب و دکمه ارسال رسید را بزنید.",
        EVIDENCE_FORMAT_UNSUPPORTED:
          "فقط عکس یا فایل PDF، PNG و JPEG مجاز است.",
        EVIDENCE_TOO_LARGE: "حجم رسید باید حداکثر ۱۰ مگابایت باشد.",
        SELF_APPROVAL_FORBIDDEN:
          "تأیید پرداخت خودتان مجاز نیست؛ مدیر دیگری باید بررسی کند.",
        SERVICE_BUSY:
          "عملیات قبلی این سرویس هنوز بسته نشده است. منتظر نتیجه بمانید.",
        UNLIMITED_RENEWAL_UNSUPPORTED:
          "تمدید محدود برای سرویس با حجم یا اعتبار نامحدود پشتیبانی نمی‌شود؛ با پشتیبانی هماهنگ کنید.",
        REMOTE_STATE_CHANGED:
          "اطلاعات سرویس در پنل خارج از کارخانه تغییر کرده است؛ مدیر باید اختلاف را بررسی کند.",
        RATE_LIMITED: "درخواست‌ها زیاد است؛ کمی صبر کنید و دوباره تلاش کنید.",
        CONNECTION_HOST_UNCONFIGURED:
          "آدرس اتصال عمومی هنوز توسط مدیر تنظیم نشده است.",
        NO_INDEPENDENT_REVIEWER:
          "برای این خرید مدیر مستقلی برای بررسی رسید وجود ندارد.",
        CHECKOUT_EXPIRED: "فرصت تأیید تمام شده است؛ طرح را دوباره انتخاب کنید.",
      } as Record<string, string>
    )[code] ??
    "درخواست انجام نشد. وضعیت سفارش را بررسی کنید یا با پشتیبانی تماس بگیرید."
  );
}
