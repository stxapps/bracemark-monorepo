// The "doors" of the DEK model and the AEAD context used to wrap the DEK. Part
// of the FROZEN cross-platform contract (see params.ts): web, extension, and the
// future native client must build the wrap AAD byte-identically, or a door fails
// to unwrap the DEK and the user is locked out of their data. See
// docs/account.md ("the DEK / KEK door model").
//
// The root of an account is a random DEK; each door derives a KEK that AEAD-wraps
// its own copy of the DEK (account_keys row: { doorType, wrappedDek, iv }).
import { utf8 } from './encoding';

export type DoorType = 'password' | 'recovery' | 'passkey';

export const DOOR_PASSWORD = 'password' satisfies DoorType;
export const DOOR_RECOVERY = 'recovery' satisfies DoorType;
export const DOOR_PASSKEY = 'passkey' satisfies DoorType;

// AAD for wrapping/unwrapping a DEK. AES-GCM authenticates (but does not encrypt)
// the AAD, so unwrap only succeeds when the SAME bytes are supplied — this binds a
// wrapped blob to its door so a malicious server can't pass off one door's blob
// as another's.
//
// The AAD is ONLY the doorType — deliberately NOT the user. The KEK already binds
// the user: the password door's KEK folds the username into its salt
// (deriveUserSalt), and the recovery/passkey KEKs come from a per-user secret, so
// a cross-user blob fails on the GCM tag regardless. Re-binding the user here
// would be redundant AND would couple every door to the username — making a future
// username change (which only re-wraps the password door, by design) have to
// re-wrap the username-independent doors too. doorType is the one piece of context
// not already in the KEK, so it is the whole AAD.
export const dekWrapAad = (doorType: DoorType): Uint8Array<ArrayBuffer> => utf8(doorType);
