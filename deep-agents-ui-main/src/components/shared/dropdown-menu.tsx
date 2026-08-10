"use client";

import type { ReactNode, ComponentProps } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

function DropdownMenu(
  props: ComponentProps<typeof DropdownMenuPrimitive.Root>,
) {
  return <DropdownMenuPrimitive.Root {...props} />;
}

function DropdownMenuTrigger({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      className={cn(
        "flex items-center justify-center rounded-md transition-colors outline-none",
        "text-muted-foreground hover:bg-muted hover:text-foreground",
        "focus-visible:ring-ring/50 focus-visible:ring-2",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "end",
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "bg-popover/95 text-popover-foreground z-50 min-w-40 overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm focus-visible:shadow-lg",
          "data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in",
          "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

interface DropdownMenuItemProps extends ComponentProps<
  typeof DropdownMenuPrimitive.Item
> {
  icon?: ReactNode;
}

const itemClassName =
  "flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none transition-colors text-muted-foreground focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50";

function DropdownMenuItem({
  className,
  icon,
  children,
  asChild,
  ...props
}: DropdownMenuItemProps) {
  if (asChild) {
    return (
      <DropdownMenuPrimitive.Item
        asChild
        className={cn(itemClassName, className)}
        {...props}
      >
        {children}
      </DropdownMenuPrimitive.Item>
    );
  }

  return (
    <DropdownMenuPrimitive.Item
      className={cn(itemClassName, className)}
      {...props}
    >
      {icon && (
        <span className="flex size-4 items-center justify-center">{icon}</span>
      )}
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn("bg-border my-1 h-px", className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        itemClassName,
        "relative pl-8 data-[state=checked]:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-3.5" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
};
