'use client';

import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input, Label, cn } from '@growth-agent/ui';

export function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  error,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  error?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <Input
          id={inputId}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-9"
          aria-invalid={error ? true : undefined}
          required
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className={cn(
            'text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2',
          )}
          aria-label={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
