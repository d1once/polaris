import { cn } from "@/lib/utils";
import { getItemPadding } from "./constants";
import { Spinner } from "@/components/ui/spinner";

export const LoadingRow = ({
  className,
  level = 0,
}: {
  className?: string;
  level: number;
}) => {
  return (
    <div
      style={{ paddingLeft: getItemPadding(level, true) }}
      className={cn("h-5.5 flex items-center text-muted-foreground", className)}
    >
      <Spinner className="size-4 text-ring ml-0.5" />
    </div>
  );
};
