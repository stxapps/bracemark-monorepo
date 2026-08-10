# @stxapps/expo-react

Expo-only React hooks/contexts/logic — the `platform:expo` sibling of
`@stxapps/web-react` (same React-logic layer, but free to use React Native and
Expo APIs). Home of the bracemark-expo local-first stack as it gets built: the
expo-sqlite + drizzle store and data layer, the sync-engine bindings, and the
RN-specific glue (e.g. `useQueryManagers`, which wires TanStack Query's
online/focus managers to NetInfo and AppState).

May import `@stxapps/shared`, `@stxapps/react`, and `@stxapps/expo-crypto`.
Only `bracemark-expo` consumes it. See `docs/architecture.md`.
