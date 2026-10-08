import type { ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

interface IconTooltipProps {
  label: string;
  children: ReactNode;
  side?: TooltipPrimitive.Positioner.Props["side"];
  className?: string;
}

/** A short, consistent hint for icon-only actions, including disabled buttons. */
export function IconTooltip({ label, children, side = "top", className = "" }: IconTooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        delay={350}
        render={<span className={`inline-flex shrink-0 ${className}`} />}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={7} className="isolate z-[100]">
          <TooltipPrimitive.Popup role="tooltip" className="max-w-56 rounded-md bg-zp-primary px-2.5 py-1.5 text-xs leading-4 whitespace-normal text-white shadow-md outline-none dark:bg-zp-surface-active dark:text-zp-primary">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
