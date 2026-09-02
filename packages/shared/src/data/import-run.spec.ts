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

  // `room` is documented as always >= 1 at the prompt: one link of room is still a
  // choice worth offering, and it is the boundary the `room < 1` test above sits
  // one step past. Between them they pin where the prompt stops being offered.
  it('still prompts when there is room for exactly one link', async () => {
    const { fn, seen } = resolver('import-what-fits');
    await expect(resolveImportQuota(1_200, 199, 200, fn)).resolves.toBe(1);
    expect(seen[0]?.room).toBe(1);
  });

  // The plan-downgrade case: the library is already PAST the cap, so `room` comes
  // out negative rather than zero. `room < 1` covers both, but only the zero half
  // was pinned — an `=== 0` check would pass every existing test and then offer a
  // prompt promising to import a negative number of links.
  it('throws without prompting when the library is already over the cap', async () => {
    const { fn } = resolver('import-what-fits');
    await expect(resolveImportQuota(1_200, 250, 200, fn)).rejects.toBeInstanceOf(ImportQuotaError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('takes a file with nothing new to add while under the cap', async () => {
    // Everything deduped away — there is nothing to refuse.
    const { fn } = resolver('cancel');
    await expect(resolveImportQuota(0, 200, 200, fn)).resolves.toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });
});

// The message is rendered VERBATIM by both import views (the class comment says
// so), which makes it product copy with no test — including a plural branch that
// only fires on a one-link file.
describe('ImportQuotaError’s message', () => {
  it('names the counts and the cap, and tells the user what to do', () => {
    const message = new ImportQuotaError(1_200, 12, 200).message;
    expect(message).toContain('1200 new links');
    expect(message).toContain('limit of 200 links');
    expect(message).toContain('you have 12');
    expect(message).toContain('Upgrade your plan or import fewer links.');
  });

  it('says "1 new link", not "1 new links"', () => {
    expect(new ImportQuotaError(1, 200, 200).message).toContain('1 new link would');
  });

  it('is an Error subclass that reports its own name', () => {
    // Both hooks branch on this to tell a cancel from a real failure and return
    // the view to idle without an error banner.
    const error = new ImportQuotaError(1_200, 12, 200);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ImportQuotaError');
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

  it('draws the line at exactly the cap', () => {
    // The gate is `>`, so filling the plan to the last link is allowed and one
    // more is not — the off-by-one that a 1200-vs-200 test cannot see.
    expect(() => assertUnderImportQuota(150, 50, 200)).not.toThrow(); // 200
    expect(() => assertUnderImportQuota(151, 50, 200)).toThrow(ImportQuotaError);
  });
});
