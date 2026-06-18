'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useFocusTrap } from '@/presentation/hooks/use-focus-trap';
import { IconClose } from './icons';

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
};

/**
 * Right-side slide-in modal panel. Closes on backdrop click or Escape. Implements the dialog
 * focus contract: moves focus into the panel on open, traps Tab inside it, and restores focus to
 * the trigger on close.
 */
export function Drawer({ open, onClose, title, children }: DrawerProps) {
  const panelRef = useFocusTrap<HTMLElement>(open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-border border-l bg-bg-elevated shadow-pop focus:outline-none before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-[color:var(--color-highlight)]"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          >
            <header className="flex items-center justify-between border-border border-b px-5 py-4">
              <div className="font-medium text-sm text-text">{title}</div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-text"
              >
                <IconClose size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
