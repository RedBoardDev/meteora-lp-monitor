/** Uppercase section label + optional count, mirroring the iOS app's `sectionLabel`. */
export function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="font-semibold text-[11px] text-faint uppercase tracking-wide">{title}</span>
      {count != null && <span className="tabular text-faint text-xs">{count}</span>}
    </div>
  );
}
