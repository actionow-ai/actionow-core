export interface UserRow {
  userId: string; // YOUR user id (becomes the subject's external_id)
  subjectId: string; // core subject id (federation join key)
  apiKey: string; // that subject's ak_ — returned ONCE at mint; ENCRYPT at rest (AES-GCM/KMS) in a real app
}

const users = new Map<string, UserRow>();

/**
 * In-memory stand-in for YOUR user table. In a real app this is your own DB;
 * store ONLY core's IDs (subject_id + ak_), never mirror core's balances/usage.
 */
export const userStore = {
  put(row: UserRow): void {
    users.set(row.userId, row);
  },
  get(userId: string): UserRow | undefined {
    return users.get(userId);
  },
};
