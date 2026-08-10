import { cn } from "@/lib/utils";
import { ReactNode } from "react";

type CardProps = {
  title?: string;
  children?: ReactNode;
  header?: ReactNode;
  className?: string;
};

type CardItemProps = {
  title?: string | ReactNode;
  description?: string | ReactNode;
  descriptionOutside?: string | ReactNode;
  align?: "start" | "center" | "end";
  actions?: ReactNode;
  column?: boolean;
  className?: string;
  classNameWrapperAction?: string;
  children?: ReactNode;
};

export function CardItem({
  title,
  description,
  descriptionOutside,
  className,
  classNameWrapperAction,
  align = "center",
  column,
  actions,
  children,
}: CardItemProps) {
  return (
    <>
      <div
        className={cn(
          "flex justify-between mt-3 first:mt-0 border-b border-border/40 pb-3 last:border-none last:pb-0 gap-4",
          descriptionOutside ? "border-0" : undefined,
          align === "start" && "items-start",
          align === "center" && "items-center",
          align === "end" && "items-end",
          column && "flex-col gap-y-2 items-start",
          className
        )}
      >
        <div className="space-y-1.5 min-w-0 flex-1">
          <h1 className="font-medium text-foreground">{title}</h1>
          {description && (
            <span className="text-muted-foreground text-sm leading-normal block">
              {description}
            </span>
          )}
        </div>
        {actions && (
          <div
            className={cn(
              "shrink-0",
              classNameWrapperAction,
              column && "w-full shrink"
            )}
          >
            {actions}
          </div>
        )}
        {children && column && <div className="w-full">{children}</div>}
      </div>
      {descriptionOutside && (
        <span className="text-muted-foreground text-sm leading-normal">
          {descriptionOutside}
        </span>
      )}
    </>
  );
}

export function JanCard({ title, children, header, className }: CardProps) {
  return (
    <div
      className={cn(
        "bg-card border border-border/40 p-4 md:p-5 rounded-xl text-muted-foreground w-full",
        className
      )}
    >
      {title && (
        <h1 className="text-foreground font-studio font-medium text-base mb-4">
          {title}
        </h1>
      )}
      {header && header}
      {children}
    </div>
  );
}
