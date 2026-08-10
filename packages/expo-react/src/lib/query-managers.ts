import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';

// TanStack Query's built-in online/focus detection is browser-only (it listens
// on window events). On React Native, connectivity comes from NetInfo and
// "refetch on focus" from AppState. The app mounts this hook once, next to its
// QueryClientProvider.
export function useQueryManagers() {
  useEffect(() => {
    onlineManager.setEventListener((setOnline) =>
      NetInfo.addEventListener((state) => {
        setOnline(state.isConnected !== false);
      }),
    );
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (Platform.OS !== 'web') {
        focusManager.setFocused(status === 'active');
      }
    });
    return () => subscription.remove();
  }, []);
}
