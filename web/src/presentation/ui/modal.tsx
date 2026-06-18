'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/presentation/hooks/use-focus-trap';
import { cn } from './cn';
import { IconClose } from './icons';

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * A centered modal dialog, portalled to <body> so it can be mounted from anywhere (e.g. inside a
 * clickable table row) without its clicks bubbling to the trigger. Closes on backdrop click or
 * Escape, and implements the dialog focus contract: focus moves in on open, Tab is trapped, focus
 * restores to the trigger on close. (Sibling of {@link Drawer}, which slides in from the side.)
 */
export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const panelRef = useFocusTrap<HTMLDivElement>(open, onClose);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        // A portalled subtree still bubbles events through the React tree to wherever <Modal> was
        // mounted (e.g. a clickable row), so stop them here or clicks would "fall through".
        // biome-ignore lint/a11y/noStaticElementInteractions: event-containment wrapper, not a control.
        <div
          className="fixed inset-0 z-50 grid place-items-center p-4"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <motion.div
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            className={cn(
              'relative z-10 flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-pop focus:outline-none',
              className,
            )}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
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
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
