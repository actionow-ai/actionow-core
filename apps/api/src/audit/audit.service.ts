import { appendAuditLog, type AppendAuditLogInput, type Database } from '@actionow/db';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { DB } from '../common/tokens.js';

/**
 * Best-effort writer for the {@link auditLog} (记录系统). A failed audit write must
 * NEVER fail or roll back the underlying mutation (the audit is a side-record, not
 * part of the money/governance transaction), so {@link record} swallows + logs
 * any error. Callers that need the row back (tests) can use the repo directly.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /** Append one audit record; never throws (logs on failure). */
  async record(input: AppendAuditLogInput): Promise<void> {
    try {
      await appendAuditLog(this.db, input);
    } catch (err) {
      this.logger.error(
        `audit record failed (${input.actorType} ${input.action} ${input.targetType})`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
