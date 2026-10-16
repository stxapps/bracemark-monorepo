// The delete-all-data flow's one outcome that is neither a finished delete nor a
// failed one (web-react and expo-react, data/delete-all-data.ts): the run was for
// an account the device no longer holds, and it stopped there.
//
// Its own class because what may happen NEXT differs. A failed call is retried by
// asking again, and this must not be — "again" would now mean whoever is signed
// in, on a confirmation the previous account gave. `serverWiped` is how far the
// run got:
//   false — the server refused the name (`account_mismatch`, ./endpoints.ts):
//           the token the request left with was not the named account's, which
//           in practice means the account changed first. (The server gives the
//           same answer for a name whose account was deleted.) Nothing was
//           deleted on the server.
//   true  — the server wiped the account that asked, and the local half then
//           found the store no longer that account's (each platform's
//           AccountFencedError) and applied none of the local wipe.
//
// "Nothing" in the first is all of it: a refused call leaves the account's
// unsynced queue where it was, too. In the second the queue went with the
// teardown that took the account off the device.
//
// Here rather than beside either flow so both throw the SAME class and a hook can
// tell it by `instanceof` without importing a module that pulls in a database.
export class DeleteAllAccountChangedError extends Error {
  constructor(public readonly serverWiped: boolean) {
    super(
      serverWiped
        ? 'Deleted on the server; this device is no longer signed in to that account'
        : 'Not deleted: the signed-in account is not the one the delete was started for',
    );
    this.name = 'DeleteAllAccountChangedError';
  }
}

// The delete-all call failed without saying whether the wipe ran: a timeout, a
// lost response, a 5xx. The route empties the op log before it pages R2 and
// answers only after the last page, so any of these can come back from a wipe
// that happened, in whole or in part. (A 4xx is a refusal the route gives before
// touching anything, and stays an ordinary error.)
//
// Its own class because the flows do one more thing on it: they drop the
// account's unsynced queue, which would otherwise push into a namespace that may
// already be empty and bring back what the user deleted. So the failure line
// cannot say "nothing was removed" — the hook's `error` state carries that
// difference (`unsyncedDiscarded`). The message is the call's own.
export class DeleteAllUncertainError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'DeleteAllUncertainError';
  }
}
