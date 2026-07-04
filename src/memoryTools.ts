export function isInfiaiMemoryToolsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(
    env.INFIAI_MEMORY_TOOLS_ENABLED ?? env.OPENCLAW_MEMORY_TOOLS_ENABLED ?? "",
  )
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
