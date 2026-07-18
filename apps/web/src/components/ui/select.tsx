// Animate UI does not publish a styled Select registry item. This local primitive follows its official tokens, focus treatment, radius, and accessibility conventions.
import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Select as SelectPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-10 w-full items-center justify-between gap-2 rounded-full bg-surface-subtle px-4 text-sm text-foreground outline-hidden transition-[outline-color,background-color] hover:bg-surface-strong/70 focus:bg-surface focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-ring data-[placeholder]:text-muted-foreground',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="size-4 text-muted-foreground" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));

SelectTrigger.displayName = 'SelectTrigger';

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <AnimatePresence>
      <SelectPrimitive.Content ref={ref} position={position} asChild {...props}>
        <motion.div
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            'z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-xl bg-surface p-1.5 text-foreground shadow-overlay data-[side=bottom]:mt-1',
            className,
          )}
        >
          <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        </motion.div>
      </SelectPrimitive.Content>
    </AnimatePresence>
  </SelectPrimitive.Portal>
));

SelectContent.displayName = 'SelectContent';

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-default select-none items-center rounded-lg py-2 pr-8 pl-3 text-sm outline-hidden transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-strong data-[state=checked]:font-medium',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className="absolute right-2 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));

SelectItem.displayName = 'SelectItem';

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
