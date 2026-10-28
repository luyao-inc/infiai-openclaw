/** Delivery-time memory invalidation check; never regenerates or rewrites a draft. */
export function validateReplyMemory(input: { validateMemory: () => Promise<boolean> }) {
  return async (answer: string): Promise<string> =>
    await input.validateMemory() ? answer : "请重新发送刚才的问题。";
}
