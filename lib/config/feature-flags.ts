/**
 * Feature flags controlled by environment variables.
 *
 * Notes:
 * - Use NEXT_PUBLIC_ prefix for flags needed in client components.
 * - Values: true/1/on/yes => enabled, others => disabled.
 */

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'true' ||
    normalized === '1' ||
    normalized === 'on' ||
    normalized === 'yes'
  );
}

export const CLASSROOM_INTERACTION_ENABLED = isEnabled(
  process.env.NEXT_PUBLIC_CLASSROOM_INTERACTION_ENABLED,
);
