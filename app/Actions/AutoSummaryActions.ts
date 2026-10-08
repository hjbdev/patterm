import type { AutoSummaryService } from '../Services/AutoSummaryService';

export class AutoSummaryActions {
  constructor(private readonly summaries: AutoSummaryService) {}
  read() { return this.summaries.status(); }
  update(raw: unknown) { return this.summaries.update(raw); }
  test(raw: unknown) { return this.summaries.test(raw); }
}
