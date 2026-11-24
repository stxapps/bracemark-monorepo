import { useEffect, useState } from 'react';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { PopupBody, PopupShell, PopupTitle } from './Shell';

import { API_HOST, API_ORIGINS, IS_SAFARI } from '@/utils/target';

// SAFARI ONLY: the step before everything else, where the user lets the extension
// reach bracemark-api.
//
// Chrome and Firefox grant `host_permissions` at install. Safari grants nothing:
// the host starts at Ask in Safari Settings → Websites, and until it is Allow every
// api call fails with a bare "Load failed". Without this screen, the first thing a
// Safari user saw was the sign-in form answering "Could not sign in. Please try
// again." for a reason no retry could fix, and a signed-in browser whose access
// lapsed ("Allow for One Day") would just stop syncing. docs/browser-extension.md,
// _Safari_.
//
// ⚠ THE REQUEST IS MADE FROM A TAB, NOT FROM THE POPUP. Measured on Safari 27.2:
// `permissions.request` from an extension page in a tab, inside a click, raises
// Safari's dialog (Deny / Always Allow / Allow for One Day) and resolves with the
// answer. The same call from the toolbar popup raised nothing at all, and the
// host stayed at Ask. So the popup's button opens this screen in a tab
// (`?api-access`), and only the tab asks.

// The popup page opened as a tab for the request, rather than as the popup.
export const API_ACCESS_PARAM = 'api-access';
export function isApiAccessTab(): boolean {
  return new URLSearchParams(window.location.search).has(API_ACCESS_PARAM);
}

// `undefined` while the check runs. Off Safari it is `true` at once, with no call,
// so Chrome and Firefox never render this screen and never wait on it.
export function useApiAccess(): [boolean | undefined, () => void] {
  const [granted, setGranted] = useState<boolean | undefined>(IS_SAFARI ? undefined : true);
  useEffect(() => {
    if (!IS_SAFARI) return;
    let live = true;
    browser.permissions
      .contains({ origins: API_ORIGINS })
      .then((has) => {
        if (live) setGranted(has);
      })
      .catch(() => {
        if (live) setGranted(false);
      });
    return () => {
      live = false;
    };
  }, []);
  return [granted, () => setGranted(true)];
}

export function ApiAccess({ inTab, onGranted }: { inTab: boolean; onGranted: () => void }) {
  const [denied, setDenied] = useState(false);

  function openTab() {
    void browser.tabs.create({ url: browser.runtime.getURL(`/popup.html?${API_ACCESS_PARAM}`) });
    window.close();
  }

  function ask() {
    // FIRST in the handler, with nothing awaited ahead of it: Safari only shows
    // its dialog for a request made inside the click.
    browser.permissions
      .request({ origins: API_ORIGINS })
      .then((granted) => {
        if (granted) onGranted();
        else setDenied(true);
      })
      .catch(() => setDenied(true));
  }

  return (
    <PopupShell>
      <PopupBody>
        <div className={cn('flex flex-col gap-1.5')}>
          <PopupTitle>Allow Bracemark to connect</PopupTitle>
          <p className={cn('text-xs leading-5 text-muted-foreground')}>
            Safari asks before an extension connects to a website. Bracemark connects to one: its
            own server, {API_HOST}, to sign you in and sync your links.
          </p>
          <p className={cn('text-xs leading-5 text-muted-foreground')}>
            Safari’s message is the same for every website. Your links reach this server only after
            they’re encrypted. Choose Always Allow, or Safari asks again tomorrow.
          </p>
        </div>

        {denied ? (
          <p
            role="alert"
            className={cn('rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-5')}
          >
            Safari didn’t allow it. To change that, open Safari Settings, then Websites, then
            Bracemark under Extensions, and set {API_HOST} to Allow.
          </p>
        ) : null}

        <Button onClick={inTab ? ask : openTab}>Continue</Button>
      </PopupBody>
    </PopupShell>
  );
}

// The tab after Safari said yes. It doesn't go on to sign in here: a tab has no
// page to save, and the toolbar button is where the user works from now on.
export function ApiAccessDone() {
  return (
    <PopupShell>
      <PopupBody>
        <div className={cn('flex flex-col gap-1.5')}>
          <PopupTitle>Bracemark can connect now</PopupTitle>
          <p className={cn('text-xs leading-5 text-muted-foreground')}>
            Close this tab, then click the Bracemark button in Safari’s toolbar to sign in.
          </p>
        </div>
      </PopupBody>
    </PopupShell>
  );
}
