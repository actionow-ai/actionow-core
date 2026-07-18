import { XIcon } from 'lucide-react';
import * as React from 'react';

import {
  Sheet as SheetPrimitive,
  SheetClose as SheetClosePrimitive,
  type SheetCloseProps as SheetClosePrimitiveProps,
  SheetContent as SheetContentPrimitive,
  type SheetContentProps as SheetContentPrimitiveProps,
  SheetDescription as SheetDescriptionPrimitive,
  type SheetDescriptionProps as SheetDescriptionPrimitiveProps,
  SheetFooter as SheetFooterPrimitive,
  type SheetFooterProps as SheetFooterPrimitiveProps,
  SheetHeader as SheetHeaderPrimitive,
  type SheetHeaderProps as SheetHeaderPrimitiveProps,
  SheetOverlay as SheetOverlayPrimitive,
  type SheetOverlayProps as SheetOverlayPrimitiveProps,
  SheetPortal as SheetPortalPrimitive,
  type SheetProps as SheetPrimitiveProps,
  SheetTitle as SheetTitlePrimitive,
  type SheetTitleProps as SheetTitlePrimitiveProps,
  SheetTrigger as SheetTriggerPrimitive,
  type SheetTriggerProps as SheetTriggerPrimitiveProps,
} from '@/components/ui/primitives/radix/sheet';
import { cn } from '@/lib/utils';

type SheetProps = SheetPrimitiveProps;

function Sheet(props: SheetProps) {
  return <SheetPrimitive {...props} />;
}

type SheetTriggerProps = SheetTriggerPrimitiveProps;

function SheetTrigger(props: SheetTriggerProps) {
  return <SheetTriggerPrimitive {...props} />;
}

type SheetOverlayProps = SheetOverlayPrimitiveProps;

function SheetOverlay({ className, ...props }: SheetOverlayProps) {
  return (
    <SheetOverlayPrimitive className={cn('fixed inset-0 z-50 bg-black/50', className)} {...props} />
  );
}

type SheetCloseProps = SheetClosePrimitiveProps;

function SheetClose(props: SheetCloseProps) {
  return <SheetClosePrimitive {...props} />;
}

type SheetContentProps = SheetContentPrimitiveProps & {
  showCloseButton?: boolean;
};

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: SheetContentProps) {
  return (
    <SheetPortalPrimitive>
      <SheetOverlay />
      <SheetContentPrimitive
        className={cn(
          'bg-surface fixed z-50 flex flex-col gap-4 shadow-overlay',
          side === 'right' && 'h-full w-[350px]',
          side === 'left' && 'h-full w-[350px]',
          side === 'top' && 'w-full h-[350px]',
          side === 'bottom' && 'w-full h-[350px]',
          className,
        )}
        side={side}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetClose className="data-[state=open]:bg-secondary absolute top-4 right-4 rounded-full p-1 opacity-70 transition-opacity hover:opacity-100 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetClose>
        )}
      </SheetContentPrimitive>
    </SheetPortalPrimitive>
  );
}

type SheetHeaderProps = SheetHeaderPrimitiveProps;

function SheetHeader({ className, ...props }: SheetHeaderProps) {
  return <SheetHeaderPrimitive className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />;
}

type SheetFooterProps = SheetFooterPrimitiveProps;

function SheetFooter({ className, ...props }: SheetFooterProps) {
  return (
    <SheetFooterPrimitive className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
  );
}

type SheetTitleProps = SheetTitlePrimitiveProps;

function SheetTitle({ className, ...props }: SheetTitleProps) {
  return (
    <SheetTitlePrimitive className={cn('text-foreground font-semibold', className)} {...props} />
  );
}

type SheetDescriptionProps = SheetDescriptionPrimitiveProps;

function SheetDescription({ className, ...props }: SheetDescriptionProps) {
  return (
    <SheetDescriptionPrimitive
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  type SheetCloseProps,
  SheetContent,
  type SheetContentProps,
  SheetDescription,
  type SheetDescriptionProps,
  SheetFooter,
  type SheetFooterProps,
  SheetHeader,
  type SheetHeaderProps,
  type SheetProps,
  SheetTitle,
  type SheetTitleProps,
  SheetTrigger,
  type SheetTriggerProps,
};
