import { AppError } from "../core";
export interface VerifiedPayment {
  provider: string;
  eventId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
}
export interface PaymentAdapter {
  checkout(
    orderId: string,
    amountMinor: number,
    currency: string,
  ): Promise<{ url: string }>;
  verify(request: Request): Promise<VerifiedPayment>;
}
export class UnconfiguredPayment implements PaymentAdapter {
  async checkout(): Promise<{ url: string }> {
    throw new AppError("PAYMENT_UNCONFIGURED", 503);
  }
  async verify(): Promise<VerifiedPayment> {
    throw new AppError("PAYMENT_UNCONFIGURED", 503);
  }
}
// No production provider is selected: no payment HTTP callback is exposed.
