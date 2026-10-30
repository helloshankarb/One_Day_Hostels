import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { SavedProvider } from './lib/saved';
import { SiteLayout } from './components/Layout';
import { Spinner } from './components/ui';
import Home from './pages/Home';
import NotFound from './pages/NotFound';

const Search = lazy(() => import('./pages/Search'));
const Property = lazy(() => import('./pages/Property'));
const Account = lazy(() => import('./pages/Account'));
const InfoPage = lazy(() => import('./pages/InfoPage'));
const Checkout = lazy(() => import('./pages/Checkout'));
const PaymentStatus = lazy(() => import('./pages/PaymentStatus'));
const BookingDetail = lazy(() => import('./pages/Bookings').then((m) => ({ default: m.BookingDetail })));
const Login = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Login })));
const Register = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Register })));
const ForgotPassword = lazy(() => import('./pages/Auth').then((m) => ({ default: m.ForgotPassword })));

/** UX guard only – Firestore rules and Cloud Functions enforce access on the server. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (!user.profileComplete) return <Navigate to="/complete-profile" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SavedProvider>
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route element={<SiteLayout />}>
                <Route index element={<Home />} />
                <Route path="search" element={<Search />} />
                <Route path="property/:slug" element={<Property />} />
                <Route path="login" element={<Login />} />
                <Route path="register" element={<Register />} />
                <Route path="complete-profile" element={<Register completeOnly />} />
                <Route path="forgot-password" element={<ForgotPassword />} />
                <Route path="account" element={<RequireAuth><Account /></RequireAuth>} />
                <Route path="account/bookings/:id" element={<RequireAuth><BookingDetail /></RequireAuth>} />
                <Route path="book/:propertyId" element={<RequireAuth><Checkout /></RequireAuth>} />
                <Route path="payment/:bookingId" element={<RequireAuth><PaymentStatus /></RequireAuth>} />
                {/* Owner and admin portals are migrated in later increments; send signed-in users to their account. */}
                <Route path="owner/*" element={<RequireAuth><Navigate to="/account" replace /></RequireAuth>} />
                <Route path="admin/*" element={<RequireAuth><Navigate to="/account" replace /></RequireAuth>} />
                {['about', 'faqs', 'terms', 'privacy', 'cancellation-policy', 'contact'].map((s) => (
                  <Route key={s} path={s} element={<InfoPage slug={s} />} />
                ))}
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Suspense>
        </SavedProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
