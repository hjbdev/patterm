import { z } from 'zod';
import type { UsageService } from '../Services/UsageService';
import type { AntigravityQuotaService } from '../Services/AntigravityQuotaService';

export const usageSummaryInput = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30)
}).strict();

export class GetUsageSummaryAction {
  constructor(private readonly usage: UsageService, private readonly quotas?: Pick<AntigravityQuotaService, 'refresh'>) {}

  async execute(raw: unknown) {
    const { days } = usageSummaryInput.parse(raw ?? {});
    // The Antigravity CLI takes seconds to report its quota. Its windows are
    // stored when it answers and appear on the page's next poll.
    void this.quotas?.refresh();
    return this.usage.cachedSummary(days);
  }
}
