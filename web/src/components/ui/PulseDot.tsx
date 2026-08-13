export function PulseDot() {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sun opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-sun" />
    </span>
  );
}
