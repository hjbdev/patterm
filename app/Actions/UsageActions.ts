import { z } from 'zod';
import type { UsageService } from '../Services/UsageService';

export const usageSummaryInput = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30)
}).strict();

export class GetUsageSummaryAction {
  constructor(private readonly usage: UsageService) {}

  execute(raw: unknown) {
    return this.usage.summary(usageSummaryInput.parse(raw ?? {}).days);
  }
}
