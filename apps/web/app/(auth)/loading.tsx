import { Spinner } from '@growth-agent/ui';

export default function AuthLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center py-20">
      <Spinner label="Loading" />
    </div>
  );
}
