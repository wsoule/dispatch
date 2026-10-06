/** The "‹ tasks" link that starts the header of every page under Two views' Tasks. */
export function BackToTasks({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-muted-foreground shrink-0 text-[12px] hover:underline"
    >
      ‹ tasks
    </button>
  );
}
