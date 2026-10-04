/** Load an authenticated Admin projection without invalidating the session when
 * an independent dependency (for example Router Runs) is unavailable. */
export async function optionalProjection<T>(label: string, load: () => Promise<T>, fallback: T, failures: string[], describe: (error: unknown) => string): Promise<T> {
  try { return await load(); } catch (error) { failures.push(`${label}: ${describe(error)}`); return fallback; }
}
