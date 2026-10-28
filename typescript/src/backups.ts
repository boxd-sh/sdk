import type { Transport } from "./_rpc.js";
import { BoxdApiDefinition } from "./_generated/definitions.js";
import { toBackup, toBackupSchedule, type Backup, type BackupSchedule } from "./models.js";
import type {
  ClearBackupScheduleRequest,
  ClearBackupScheduleResponse,
  DeleteBackupRequest,
  DeleteBackupResponse,
  GetBackupScheduleRequest,
  GetBackupScheduleResponse,
  ListBackupsRequest,
  ListBackupsResponse,
  RestoreBackupRequest,
  RestoreBackupResponse,
  SetBackupScheduleRequest,
  SetBackupScheduleResponse,
  TriggerBackupRequest,
  TriggerBackupResponse,
} from "./_generated/definitions.js";

/**
 * Scheduled disaster-recovery disk backups. Off by default. Enabling copies
 * the machine's disk to object storage on an interval; restoring is a full,
 * destructive disk rewrite (unlike a checkpoint restore, running/memory
 * state is not restored — the machine cold-boots into the restored disk).
 */
export class MachineBackups {
  constructor(private readonly transport: Transport) {}

  /** `null` means backups are off. */
  async schedule(id: string): Promise<BackupSchedule | null> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.getBackupSchedule,
      { vm: id },
    );
    return toBackupSchedule(resp);
  }

  /**
   * Enable or update the schedule. Pass exactly one of `intervalSecs`
   * (relative to the last backup) or `cron` (wall-clock, standard 5-field
   * cron syntax).
   */
  async setSchedule(
    id: string,
    opts: { intervalSecs: number; retentionSecs: number } | { cron: string; retentionSecs: number },
  ): Promise<void> {
    const [scheduleKind, scheduleValue] =
      "intervalSecs" in opts ? (["interval", String(opts.intervalSecs)] as const) : (["cron", opts.cron] as const);
    await this.transport.unary(BoxdApiDefinition.methods.setBackupSchedule,
      { vm: id, scheduleKind, scheduleValue, retentionSecs: opts.retentionSecs },
    );
  }

  /** Disable backups for this machine. */
  async clearSchedule(id: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.clearBackupSchedule,
      { vm: id },
    );
  }

  async list(id: string): Promise<Backup[]> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.listBackups,
      { vm: id },
    );
    return (resp.backups ?? []).map(toBackup);
  }

  /** Back up the machine's disk right now, regardless of any schedule.
   * Resolves to the id of the queued backup. */
  async trigger(id: string): Promise<string> {
    const resp = await this.transport.unary(BoxdApiDefinition.methods.triggerBackup,
      { vm: id },
    );
    return resp.backupId;
  }

  /** Delete a single backup. Rejected while it is still being captured or
   * while a newer unchanged-since backup still points at it. */
  async delete(id: string, backupId: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.deleteBackup,
      { vm: id, backupId },
    );
  }

  /** Restore the machine's disk from a backup IN PLACE. Destructive: overwrites
   * the machine's current disk; anything since is lost. */
  async restore(id: string, backupId: string): Promise<void> {
    await this.transport.unary(BoxdApiDefinition.methods.restoreBackup,
      { vm: id, backupId },
    );
  }
}
