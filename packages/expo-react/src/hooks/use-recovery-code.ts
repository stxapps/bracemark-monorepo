import { useMutation } from '@tanstack/react-query';

import { regenerateRecoveryDoor } from '@stxapps/expo-crypto';
import { useApiClient } from '@stxapps/react';
import {
  ApiError,
  bytesToHex,
  generateRecoveryCode,
  putRecoveryDoorEndpoint,
  type PutRecoveryDoorPayload,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { type DoorProofInput, mapOpenError, openerForProof } from './use-change-password';
import { InvalidCredentialsError } from './use-sign-in';

// The expo sibling of web-react's hooks/use-recovery-code.ts, verbatim in
// contract (see there): generate or regenerate the recovery door — an upsert
// that REPLACES any previous door, invalidating its code. Same tier-1 rotation
// as changePassword. The freshly minted code is RETURNED so the UI can show it
// once, wallet-style; it is never stored.

export function useRecoveryCode() {
  const api = useApiClient();
  const { username } = useAuth();

  return useMutation({
    // Returns the new recovery code for one-time display. `proof` opens the DEK;
    // the code is minted here with a CSPRNG (generateRecoveryCode), never typed.
    mutationFn: async ({ proof }: { proof: DoorProofInput }): Promise<{ recoveryCode: string }> => {
      if (!username) throw new Error('You must be signed in to set a recovery code.');

      const recoveryCode = generateRecoveryCode();

      // Step 1: open the DEK via the presented door (password or current recovery code).
      const opener = await openerForProof(api, username, proof);

      // Step 2: re-wrap the DEK under the NEW recovery code's KEK (a cheap HKDF).
      // Returns the new door AND the unchanged account for signing the proof.
      const { recoveryDoor, account } = await regenerateRecoveryDoor(recoveryCode, opener).catch(
        mapOpenError,
      );

      // Step 3: sign the action-bound proof (carrying the new door) and POST it.
      const payload = JSON.stringify({
        action: 'put-recovery-door',
        username,
        publicKey: account.publicKey,
        recoveryDoor: {
          wrappedDek: bytesToHex(recoveryDoor.wrappedDek),
          iv: bytesToHex(recoveryDoor.iv),
        },
        timestamp: Date.now(),
      } satisfies PutRecoveryDoorPayload);
      const signature = await account.sign(payload);

      try {
        await api.call(putRecoveryDoorEndpoint, { payload, signature });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw new InvalidCredentialsError();
        throw err;
      }

      return { recoveryCode };
    },
  });
}
