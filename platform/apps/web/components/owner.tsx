import { OWNERS, type OwnerId } from "@/content/team";

const TONE: Record<OwnerId, string> = {
  rasheed: "bg-rasheed-bg text-rasheed",
  nicolas: "bg-nicolas-bg text-nicolas",
};

const DIM = {
  sm: "h-5 w-5 text-[10px]",
  md: "h-7 w-7 text-xs",
  lg: "h-10 w-10 text-sm",
} as const;

export function OwnerAvatar({ owner, size = "sm" }: { owner: OwnerId; size?: keyof typeof DIM }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${DIM[size]} ${TONE[owner]}`}
      title={OWNERS[owner].name}
      aria-hidden="true"
    >
      {OWNERS[owner].initials}
    </span>
  );
}

export function OwnerName({ owner, size = "sm" }: { owner: OwnerId; size?: keyof typeof DIM }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-fg">
      <OwnerAvatar owner={owner} size={size} />
      {OWNERS[owner].name}
    </span>
  );
}
