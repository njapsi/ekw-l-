import { Spinner } from '@growth-agent/ui';

export default function MarketingLoading() {
  return (
    <div className="container flex min-h-[40vh] items-center justify-center py-20">
      <Spinner label="Loading page" />
    </div>
  );
}
