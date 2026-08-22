/**
 * ProgressBar.jsx
 *
 * Purely presentational. Takes known/total as props, renders an animated fill
 * bar with percentage. Safe to render at 0/0 (shows 0%).
 *
 * Props:
 *   known  {number}  blocks decoded so far
 *   total  {number}  total blocks (k)
 *   label  {string}  optional override label
 */
export default function ProgressBar({ known = 0, total = 0, label }) {
  const pct = total > 0 ? Math.min(100, Math.round((known / total) * 100)) : 0

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{label ?? `${known} / ${total} blocks`}</span>
        <span className="font-semibold text-white">{pct}%</span>
      </div>
      <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
