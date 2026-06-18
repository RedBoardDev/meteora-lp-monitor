'use client';

import { useState } from 'react';
import { COPIED_RESET_MS } from '@/presentation/ui/timing';

/** Copy text to the clipboard and flash a brief `copied` confirmation (auto-resets after
 *  COPIED_RESET_MS). Clipboard failures (blocked permission) are swallowed. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      /* clipboard blocked — ignore */
    }
  }
  return { copied, copy };
}
