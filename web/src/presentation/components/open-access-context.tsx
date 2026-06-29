'use client';

import { createContext, type ReactNode, useContext } from 'react';

/**
 * Open-access mode flag, seeded server-side (from the backend `/config/app`) and read by the client
 * shells to drop the multi-wallet + notifications surface. Defaults to false (secure behavior) when
 * read outside a provider.
 */
const OpenAccessContext = createContext(false);

export function OpenAccessProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <OpenAccessContext.Provider value={value}>{children}</OpenAccessContext.Provider>;
}

export function useOpenAccess(): boolean {
  return useContext(OpenAccessContext);
}
