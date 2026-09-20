import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const ToastProvider = ToastPrimitive.Provider;

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      'fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:bottom-4 sm:right-4 sm:max-w-sm',
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

const toastVariants = cva(
  'group pointer-events-auto relative flex w-full items-start justify-between gap-3 overflow-hidden rounded-lg border p-4 shadow-lg animate-in slide-in-from-bottom sm:slide-in-from-right',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        success:
          'border-success/40 bg-card text-card-foreground [&_[data-toast-icon]]:text-success',
        warning:
          'border-warning/40 bg-card text-card-foreground [&_[data-toast-icon]]:text-warning',
        destructive:
          'border-destructive/40 bg-card text-card-foreground [&_[data-toast-icon]]:text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => (
  <ToastPrimitive.Root ref={ref} className={cn(toastVariants({ variant }), className)} {...props} />
));
Toast.displayName = ToastPrimitive.Root.displayName;

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title ref={ref} className={cn('text-sm font-medium', className)} {...props} />
));
ToastTitle.displayName = ToastPrimitive.Title.displayName;

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn('text-muted-foreground mt-1 text-sm', className)}
    {...props}
  />
));
ToastDescription.displayName = ToastPrimitive.Description.displayName;

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Action
    ref={ref}
    className={cn(
      'hover:bg-accent shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
      className,
    )}
    {...props}
  />
));
ToastAction.displayName = ToastPrimitive.Action.displayName;

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      'text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute right-2 top-2 rounded-md p-1 opacity-0 transition-opacity focus:opacity-100 focus:outline-none focus-visible:ring-2 group-hover:opacity-100',
      className,
    )}
    aria-label="Dismiss"
    {...props}
  >
    <X className="size-4" aria-hidden />
  </ToastPrimitive.Close>
));
ToastClose.displayName = ToastPrimitive.Close.displayName;

// --- A minimal store + hook, in the style already established for this repo
// (small hand-rolled primitives over a dependency — no zustand/jotai/etc). ---

interface ToastItem {
  id: string;
  title?: string;
  description?: string;
  variant?: VariantProps<typeof toastVariants>['variant'];
  action?: React.ReactNode;
}

type Listener = (toasts: ToastItem[]) => void;
let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(toasts);
}

function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Push a toast from anywhere (a Server Action result handler, an event
 * callback, …). Auto-dismisses after 5s. */
function toast(input: Omit<ToastItem, 'id'>) {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, ...input }];
  emit();
  setTimeout(() => dismissToast(id), 5_000);
  return id;
}

function useToast() {
  const [items, setItems] = React.useState<ToastItem[]>(toasts);
  React.useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);
  return { toasts: items, toast, dismiss: dismissToast };
}

/** Mount once near the root (`Providers`). Renders whatever `toast()` pushes. */
function Toaster() {
  const { toasts: items, dismiss } = useToast();
  return (
    <ToastProvider swipeDirection="right">
      {items.map(({ id, title, description, variant, action }) => (
        <Toast key={id} variant={variant} onOpenChange={(open) => !open && dismiss(id)}>
          <div className="flex-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}

export {
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastAction,
  ToastClose,
  useToast,
  toast,
  Toaster,
};
