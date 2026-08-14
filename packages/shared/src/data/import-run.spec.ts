import {
  assertUnderImportQuota,
  type ImportQuotaAnswer,
  ImportQuotaError,
  type ImportQuotaPrompt,
  resolveImportQuota,
} from './import-run';

// A resolver that records what it was asked and answers with a fixed choice.
function resolver(answer: ImportQuotaAnswer) {
  const seen: ImportQuotaPrompt[] = [];
  const fn = jest.fn(async (prompt: ImportQuotaPrompt) => {
    seen.push(prompt);
    return answer;
  });
  return { fn, seen };
}

describe('resolveImportQuota', () => {
  it('takes the whole file when the plan is unlimited', async () => {
    const { fn } = resolver('cancel');
    await expect(resolveImportQuota(8_400, 1_000, null, fn)).resolves.toBe(8_400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('takes the whole file when it fits exactly', async () => {
    const { fn } = resolver('cancel');
    await expect(resolveImportQuota(150, 50, 200, fn)).resolves.toBe(150);
    expect(fn).not.toHaveBeenCalled();
  });

  it('prompts with the room left, and truncates to it when told to', async () => {
    const { fn, seen } = resolver('import-what-fits');
    await expect(resolveImportQuota(1_200, 12, 200, fn)).resolves.toBe(188);
    expect(seen).toEqual([{ newCount: 1_200, existingCount: 12, maxLinks: 200, room: 188 }]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses the file when the user cancels at the prompt', async () => {
    const { fn } = resolver('cancel');
    await expect(resolveImportQuota(1_200, 12, 200, fn)).rejects.toBeInstanceOf(ImportQuotaError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // No room means no choice worth offering — one link over is still a refusal.
  it('throws without prompting when the library is already at the cap', async () => {
    const { fn } = resolver('import-what-fits');
    await expect(resolveImportQuota(1_200, 200, 200, fn)).rejects.toBeInstanceOf(ImportQuotaError);
    expect(fn).not.toHaveBeenCalled();
  });

  // The safe default: a caller that can't ask refuses rather than truncating
  // behind the user's back.
  it('throws rather than truncating when no resolver is passed', async () => {
    await expect(resolveImportQuota(1_200, 12, 200)).rejects.toBeInstanceOf(ImportQuotaError);
  });
});

describe('assertUnderImportQuota', () => {
  // The backup path keeps whole-file refusal: a partially restored backup is
  // indistinguishable from a corrupt one.
  it('throws when the backup would pass the cap', () => {
    expect(() => assertUnderImportQuota(1_200, 12, 200)).toThrow(ImportQuotaError);
  });

  it('passes when it fits, and when the plan is unlimited', () => {
    expect(() => assertUnderImportQuota(150, 50, 200)).not.toThrow();
    expect(() => assertUnderImportQuota(8_400, 1_000, null)).not.toThrow();
  });
});
