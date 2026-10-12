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
// "Nothing" is about the wipe. Both flows abandon the account's unsynced queue
// BEFORE the server call, so on either outcome that queue is already gone.
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
