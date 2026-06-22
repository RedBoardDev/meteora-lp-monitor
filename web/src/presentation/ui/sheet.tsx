'use client';

import { AnimatePresence, motion, type PanInfo } from 'motion/react';
import type { ReactNode } from 'react';
import { useFocusTrap } from '@/presentation/hooks/use-focus-trap';
import { IconClose } from './icons';

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
};

// Release thresholds for swipe-to-dismiss: a long enough drag OR a fast enough flick closes the sheet.
const DISMISS_OFFSET = 120;
const DISMISS_VELOCITY = 600;

/**
 * Bottom sheet — the mobile counterpart of {@link Drawer}. Slides up from the bottom, dismisses on
 * backdrop tap, Escape, or a downward swipe (drag past {@link DISMISS_OFFSET} or a fast flick).
 * Same dialog focus contract as Drawer/Modal via {@link useFocusTrap}.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const panelRef = useFocusTrap<HTMLElement>(open, onClose);

  function onDragEnd(_e: unknown, info: PanInfo) {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onClose();
  }

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
            className="absolute inset-x-0 bottom-0 flex max-h-[90dvh] flex-col rounded-t-2xl border-border border-t bg-bg-elevated shadow-pop focus:outline-none"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={onDragEnd}
          >
            {/* Grab handle — also the primary drag affordance. */}
            <div className="flex shrink-0 cursor-grab justify-center pt-2.5 pb-1 active:cursor-grabbing">
              <div className="h-1 w-9 rounded-full bg-border-strong" />
            </div>
            <header className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0 font-medium text-sm text-text">{title}</div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="grid size-9 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
              >
                <IconClose size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto overscroll-contain pb-[max(1.25rem,env(safe-area-inset-bottom))]">
              {children}
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
