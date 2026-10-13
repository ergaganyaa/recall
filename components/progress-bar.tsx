export function ProgressBar({
  percent,
  label,
  className = "",
}: {
  percent: number;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`h-2 w-full overflow-hidden rounded-full bg-border ${className}`}
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  );
}
