import { Link, useParams } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { ButtonLink, useDocumentTitle } from '../components/ui';
import NotFound from './NotFound';

const PAGES: Record<string, { title: string; body: string[] }> = {
  about: {
    title: 'About One Day Hostels',
    body: [
      'One Day Hostels is a Visakhapatnam-first platform for booking hostels, PGs, co-living rooms and dormitory beds – for a single night, a week or a full month.',
      'Every listing is reviewed by our local team before it goes live. Properties publish their daily breakfast, lunch and dinner menus so you know exactly what the mess serves, with clear vegetarian and non-vegetarian markings.',
      'We work directly with property owners across Madhurawada, MVP Colony, Siripuram, Rushikonda, Dwaraka Nagar, Gajuwaka, Seethammadhara, Akkayyapalem, Beach Road and NAD Junction.',
    ],
  },
  faqs: {
    title: 'Frequently asked questions',
    body: [
      'Can I book for just one night? Yes. Properties that accept daily stays show a per-day price. Dormitory beds near NAD Junction and Akkayyapalem are popular for one-night transits.',
      'What does “Pure Veg Kitchen” mean? The property runs a dedicated vegetarian kitchen – no meat, fish or egg is cooked on the premises. This is a property classification, not just today’s menu.',
      'Is food included? Most PGs include three meals in the rent. Each room card states whether meals are included. “No food service” properties provide accommodation only.',
      'How are reviews verified? Only guests with a completed stay booked through One Day Hostels can review a property.',
    ],
  },
  terms: {
    title: 'Terms of Service',
    body: [
      'By using One Day Hostels you agree to provide accurate information, follow each property’s house rules and carry a valid government photo ID at check-in.',
      'Prices are shown in Indian Rupees and include applicable GST where stated. Security deposits for monthly stays are refundable as per the property’s policy.',
      'Property owners are responsible for the accuracy of listings, menus and room inventory. We may suspend listings that breach our verification standards.',
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    body: [
      'We collect your name, email and mobile number to create your account and share contact details with the property you book. We never sell personal data.',
      'Authentication is handled by Google Firebase. Payment details are processed by our payment partner and are never stored on our servers.',
      'You can update your profile at any time from your account page, or contact support to request deletion of your data.',
    ],
  },
  'cancellation-policy': {
    title: 'Cancellation & refund policy',
    body: [
      'Flexible: full refund up to 24 hours before check-in, 50% after that.',
      'Moderate: full refund up to 3 days before check-in, 50% up to 24 hours before, no refund after.',
      'Strict: 50% refund up to 7 days before check-in, no refund after.',
      'All policies: free cancellation within 24 hours of booking (before check-in). Security deposits are always refunded in full on cancellation. Checked-in stays cannot be cancelled online.',
    ],
  },
  contact: {
    title: 'Contact us',
    body: [
      'Vizag Care helpline: 1800-123-4567 (9 AM – 9 PM, all days).',
      'Email: support@onedayhostels.in',
      'Office: Dwaraka Nagar, Visakhapatnam, Andhra Pradesh 530016.',
    ],
  },
};

export default function InfoPage({ slug: fixed }: { slug?: string }) {
  const params = useParams();
  const slug = fixed ?? params.slug ?? '';
  const page = PAGES[slug];
  useDocumentTitle(page?.title ?? 'Not found');
  if (!page) return <NotFound />;
  return (
    <div className="container-x max-w-3xl py-12">
      <p className="eyebrow">One Day Hostels</p>
      <h1 className="mt-2 text-3xl font-extrabold">{page.title}</h1>
      <div className="card mt-8 space-y-4 p-6 text-sm leading-relaxed text-muted">
        {page.body.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink to="/search"><Compass className="size-4" /> Find stays</ButtonLink>
        <Link to="/faqs" className="self-center text-sm font-bold text-teal">Read FAQs</Link>
      </div>
    </div>
  );
}
