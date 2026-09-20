import * as React from 'react';
import {
  Command as CommandRoot,
  CommandEmpty as CmdkEmpty,
  CommandGroup as CmdkGroup,
  CommandInput as CmdkInput,
  CommandItem as CmdkItem,
  CommandList as CmdkList,
  CommandSeparator as CmdkSeparator,
} from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Dialog, DialogContent } from './dialog.js';

// cmdk v1's sub-components are separate named exports (`CommandInput`,
// `CommandList`, …), not properties of `Command` — the older
// `Command.Input`-style API these were once modeled on no longer exists.

const Command = React.forwardRef<
  React.ElementRef<typeof CommandRoot>,
  React.ComponentPropsWithoutRef<typeof CommandRoot>
>(({ className, ...props }, ref) => (
  <CommandRoot
    ref={ref}
    className={cn(
      'bg-card text-card-foreground flex h-full w-full flex-col overflow-hidden rounded-lg',
      className,
    )}
    {...props}
  />
));
Command.displayName = 'Command';

/** The command palette dialog: `Cmd+K` (Part 23). Reuses the existing Dialog
 * primitive for its overlay/portal/focus-trap rather than a second modal
 * implementation. */
function CommandDialog({ children, ...props }: React.ComponentProps<typeof Dialog>) {
  return (
    <Dialog {...props}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0 shadow-2xl">
        <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CmdkInput>,
  React.ComponentPropsWithoutRef<typeof CmdkInput>
>(({ className, ...props }, ref) => (
  <div className="flex items-center gap-2 border-b px-3">
    <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
    <CmdkInput
      ref={ref}
      className={cn(
        'placeholder:text-muted-foreground flex h-11 w-full bg-transparent py-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = 'CommandInput';

const CommandList = React.forwardRef<
  React.ElementRef<typeof CmdkList>,
  React.ComponentPropsWithoutRef<typeof CmdkList>
>(({ className, ...props }, ref) => (
  <CmdkList
    ref={ref}
    className={cn('max-h-80 overflow-y-auto overflow-x-hidden p-1', className)}
    {...props}
  />
));
CommandList.displayName = 'CommandList';

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CmdkEmpty>,
  React.ComponentPropsWithoutRef<typeof CmdkEmpty>
>((props, ref) => (
  <CmdkEmpty ref={ref} className="text-muted-foreground py-6 text-center text-sm" {...props} />
));
CommandEmpty.displayName = 'CommandEmpty';

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CmdkGroup>,
  React.ComponentPropsWithoutRef<typeof CmdkGroup>
>(({ className, ...props }, ref) => (
  <CmdkGroup
    ref={ref}
    className={cn(
      'text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = 'CommandGroup';

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CmdkSeparator>,
  React.ComponentPropsWithoutRef<typeof CmdkSeparator>
>(({ className, ...props }, ref) => (
  <CmdkSeparator ref={ref} className={cn('bg-border -mx-1 my-1 h-px', className)} {...props} />
));
CommandSeparator.displayName = 'CommandSeparator';

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CmdkItem>,
  React.ComponentPropsWithoutRef<typeof CmdkItem>
>(({ className, ...props }, ref) => (
  <CmdkItem
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none',
      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
      'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = 'CommandItem';

function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
};
