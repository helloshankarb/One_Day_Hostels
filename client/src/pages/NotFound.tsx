import { Compass } from 'lucide-react';
import { ButtonLink, useDocumentTitle } from '../components/ui';

export default function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <div className="container-x flex flex-col items-center py-24 text-center">
      <p className="text-6xl font-extrabold text-teal">404</p>
      <h1 className="mt-3 text-2xl font-extrabold">We couldn’t find that page</h1>
      <p className="mt-2 max-w-md text-sm text-muted">The link may be broken, or the property may no longer be listed on One Day Hostels.</p>
      <ButtonLink to="/search" className="mt-6">
        <Compass className="size-4" /> Explore stays in Vizag
      </ButtonLink>
    </div>
  );
}
