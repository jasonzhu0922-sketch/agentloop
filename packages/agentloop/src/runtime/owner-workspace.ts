/**
 * Stable filesystem segment for an opaque authenticated owner id.
 * The prefix keeps even special ids such as `.` from being interpreted as a
 * path component, while URI encoding prevents a user id from adding segments.
 */
export function ownerWorkspaceSegment(ownerUserId: string): string {
  if (typeof ownerUserId !== "string" || ownerUserId.length === 0 || ownerUserId.includes("\0")) {
    throw new Error("owner_user_id_invalid");
  }
  return `user-${encodeURIComponent(ownerUserId)}`;
}
