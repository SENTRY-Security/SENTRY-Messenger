// Restore/backup policy constants (no functions).
// Tune these values in one place to keep DR snapshot/restore behavior consistent.

export const REMOTE_BACKUP_TRIGGER_DECRYPT_OK_BATCH = 1;
export const REMOTE_BACKUP_TRIGGER_SEND_OK_BATCH = 1;
export const REMOTE_BACKUP_FORCE_ON_LOGOUT = true;
export const LOCAL_SNAPSHOT_FLUSH_ON_EACH_EVENT = true;
export const RESTORE_PIPELINE_LOG_CAP = 5;
