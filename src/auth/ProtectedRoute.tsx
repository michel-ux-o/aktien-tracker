import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';

export function ProtectedRoute() {
  const { user, loading, error, refresh } = useAuth();
  const location = useLocation();
  if (loading) return <div className="initial-state"><LoadingState label="Sitzung wird geprüft …" /></div>;
  if (error) return <div className="initial-state"><ErrorState error={error} onRetry={() => { void refresh(); }} /></div>;
  if (!user) return <Navigate to="/anmelden" state={{ from: location.pathname + location.search }} replace />;
  return <Outlet />;
}
