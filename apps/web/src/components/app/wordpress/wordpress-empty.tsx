import Link from 'next/link';
import { PenSquare } from 'lucide-react';
import { Button, EmptyState } from '@growth-agent/ui';

export function WordPressEmpty() {
  return (
    <EmptyState
      icon={<PenSquare />}
      title="Connect a WordPress site to begin."
      description="Growth Agent authenticates with a WordPress Application Password over the core REST API — never scraping, never storing your admin password. Connect from the Connections page."
      action={
        <Button asChild>
          <Link href="/app/integrations/wordpress">Connect WordPress</Link>
        </Button>
      }
    />
  );
}
