"use client";

import { memo, useRef, useState, type ComponentPropsWithoutRef, type FC } from "react";
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { ChevronLeftIcon, ChevronRightIcon, SparklesIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type IconComponent = FC<{ className?: string }>;
type DirectiveBehaviorProps = { formatter?: Unstable_DirectiveFormatter | undefined; onInserted?: ((item: Unstable_TriggerItem) => void) | undefined; };
type ActionBehaviorProps = { formatter?: Unstable_DirectiveFormatter | undefined; onExecute: (item: Unstable_TriggerItem) => void; removeOnExecute?: boolean | undefined; };
type ComposerTriggerPopoverBaseProps = Omit<ComponentPropsWithoutRef<typeof ComposerPrimitive.Unstable_TriggerPopover>, "children"> & {
  iconMap?: Record<string, IconComponent>;
  fallbackIcon?: IconComponent;
  backLabel?: string;
  emptyCategoriesLabel?: string;
  emptyItemsLabel?: string;
  loadingLabel?: string;
};
type ComposerTriggerPopoverProps = ComposerTriggerPopoverBaseProps & (| { directive: DirectiveBehaviorProps; action?: never } | { action: ActionBehaviorProps; directive?: never });

function resolveIcon(iconKey: string | undefined, iconMap: Record<string, IconComponent> | undefined, fallback: IconComponent): IconComponent {
  if (iconKey && iconMap?.[iconKey]) return iconMap[iconKey]!;
  return fallback;
}

const SearchBar: FC<{ value: string; onChange: (v: string) => void; placeholder?: string }> = ({ value, onChange, placeholder = "Search..." }) => (
  <div className="px-2 py-1.5 border-b">
    <div className="relative">
      <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus
        className="w-full pl-7 pr-2 py-1 text-sm bg-muted/50 rounded-md outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60" />
    </div>
  </div>
);

type CategoriesProps = { iconMap: Record<string, IconComponent> | undefined; fallbackIcon: IconComponent; emptyLabel: string; };
const Categories: FC<CategoriesProps> = ({ iconMap, fallbackIcon, emptyLabel }) => {
  const [search, setSearch] = useState("");
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverCategories>
      {(categories) => {
        const filtered = categories.filter((c) => c.label.toLowerCase().includes(search.toLowerCase()));
        return (
          <div data-slot="composer-trigger-popover-categories" className="flex flex-col">
            {categories.length > 4 && <SearchBar value={search} onChange={setSearch} placeholder="Search category..." />}
            <div className="max-h-56 overflow-y-auto py-1">
              {filtered.map((cat) => {
                const Icon = resolveIcon(cat.id, iconMap, fallbackIcon);
                return (
                  <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem key={cat.id} categoryId={cat.id}
                    className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm transition-colors outline-none">
                    <span className="flex items-center gap-2"><Icon className="text-muted-foreground size-4" />{cat.label}</span>
                    <ChevronRightIcon className="text-muted-foreground size-4" />
                  </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
                );
              })}
              {filtered.length === 0 && <div className="text-muted-foreground px-3 py-2 text-sm">{emptyLabel}</div>}
            </div>
          </div>
        );
      }}
    </ComposerPrimitive.Unstable_TriggerPopoverCategories>
  );
};

type ItemsProps = { iconMap: Record<string, IconComponent> | undefined; fallbackIcon: IconComponent; backLabel: string; emptyLabel: string; loadingLabel: string; };
const Items: FC<ItemsProps> = ({ iconMap, fallbackIcon, backLabel, emptyLabel, loadingLabel }) => {
  const { isLoading } = unstable_useTriggerPopoverScopeContext();
  const [search, setSearch] = useState("");
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems>
      {(items) => {
        const filtered = items.filter((item) =>
          item.label.toLowerCase().includes(search.toLowerCase()) ||
          (item.description ?? "").toLowerCase().includes(search.toLowerCase())
        );
        return (
          <div data-slot="composer-trigger-popover-items" className="flex flex-col">
            <ComposerPrimitive.Unstable_TriggerPopoverBack className="text-muted-foreground hover:bg-accent flex cursor-pointer items-center gap-1.5 border-b px-3 py-2 text-xs tracking-wide uppercase transition-colors">
              <ChevronLeftIcon className="size-3.5" />{backLabel}
            </ComposerPrimitive.Unstable_TriggerPopoverBack>
            {items.length > 5 && <SearchBar value={search} onChange={setSearch} placeholder="Search..." />}
            <div className="max-h-64 overflow-y-auto py-1">
              {filtered.map((item, index) => {
                const iconKey = typeof item.metadata?.icon === "string" ? item.metadata.icon : undefined;
                const Icon = resolveIcon(iconKey, iconMap, fallbackIcon);
                return (
                  <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} index={index}
                    className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-start transition-colors outline-none">
                    <span className="flex items-center gap-2 text-sm font-medium"><Icon className="text-primary size-3.5" />{item.label}</span>
                    {item.description && <span className="text-muted-foreground ms-5.5 text-xs leading-tight">{item.description}</span>}
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                );
              })}
              {filtered.length === 0 && (
                <div className="text-muted-foreground px-3 py-2 text-sm">
                  {isLoading ? loadingLabel : search ? `No results for "${search}"` : emptyLabel}
                </div>
              )}
            </div>
          </div>
        );
      }}
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  );
};

const ComposerTriggerPopoverImpl: FC<ComposerTriggerPopoverProps> = ({
  iconMap, fallbackIcon = SparklesIcon, backLabel = "Back",
  emptyCategoriesLabel = "No items available", emptyItemsLabel = "No matching items",
  loadingLabel = "Loading...", className, directive, action, ...props
}) => {
  const warnedRef = useRef(false);
  if (process.env.NODE_ENV !== "production" && !warnedRef.current && Boolean(directive) === Boolean(action)) {
    warnedRef.current = true;
    console.warn("[assistant-ui] ComposerTriggerPopover requires exactly one of `directive` or `action` props.");
  }
  return (
    <ComposerPrimitive.Unstable_TriggerPopover data-slot="composer-trigger-popover"
      className={cn("aui-composer-trigger-popover bg-popover text-popover-foreground absolute start-0 bottom-full z-50 mb-2 w-72 overflow-hidden rounded-xl border shadow-lg", className)}
      {...props}>
      {directive ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={directive.formatter ?? unstable_defaultDirectiveFormatter} onInserted={directive.onInserted} />
      ) : action ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Action formatter={action.formatter ?? unstable_defaultDirectiveFormatter} onExecute={action.onExecute} removeOnExecute={action.removeOnExecute} />
      ) : null}
      <Categories iconMap={iconMap} fallbackIcon={fallbackIcon} emptyLabel={emptyCategoriesLabel} />
      <Items iconMap={iconMap} fallbackIcon={fallbackIcon} backLabel={backLabel} emptyLabel={emptyItemsLabel} loadingLabel={loadingLabel} />
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};
ComposerTriggerPopoverImpl.displayName = "ComposerTriggerPopover";
export const ComposerTriggerPopover = memo(ComposerTriggerPopoverImpl) as FC<ComposerTriggerPopoverProps>;
