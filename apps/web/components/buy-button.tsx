import { Button } from '@/components/ui/button';
import { CHECKOUT_URL, PROJECT_STATUS } from '@/lib/site';

/**
 * Live link when NEXT_PUBLIC_CHECKOUT_URL is a valid https URL; otherwise a disabled button
 * with a plain explanation. Purchases are not live yet, so the disabled state is the default.
 */
export function BuyButton() {
  if (CHECKOUT_URL) {
    return (
      <Button asChild size="lg" className="w-full sm:w-auto">
        <a href={CHECKOUT_URL} rel="noopener noreferrer">
          Buy a license
        </a>
      </Button>
    );
  }
  return (
    <div>
      <Button size="lg" disabled aria-describedby="buy-note" className="w-full sm:w-auto">
        On hold
      </Button>
      <p id="buy-note" className="mt-3 max-w-[36ch] text-sm text-ink-3">
        {PROJECT_STATUS.pro}
      </p>
    </div>
  );
}
