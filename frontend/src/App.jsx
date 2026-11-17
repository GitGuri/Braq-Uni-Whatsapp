import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { Spin } from 'antd'
import ProtectedRoute from './auth/ProtectedRoute.jsx'
import DashboardLayout from './layouts/DashboardLayout.jsx'

// Route pages are code-split so the initial bundle stays small.
const Login              = lazy(() => import('./pages/Login.jsx'))
const Dashboard          = lazy(() => import('./pages/Dashboard.jsx'))
const JobsBoard          = lazy(() => import('./pages/Jobs/JobsBoard.jsx'))
const JobPage            = lazy(() => import('./pages/Jobs/JobPage.jsx'))
const OrderRedirect      = lazy(() => import('./pages/Jobs/OrderRedirect.jsx'))
const ClientsList        = lazy(() => import('./pages/Clients/ClientsList.jsx'))
const ClientDetail       = lazy(() => import('./pages/Clients/ClientDetail.jsx'))
const ProductsList       = lazy(() => import('./pages/Products/ProductsList.jsx'))
const TicketsList        = lazy(() => import('./pages/Tickets/TicketsList.jsx'))
const TicketDetail       = lazy(() => import('./pages/Tickets/TicketDetail.jsx'))
const InboxList          = lazy(() => import('./pages/Inbox/InboxList.jsx'))
const ConversationChat   = lazy(() => import('./pages/Inbox/ConversationChat.jsx'))
const StaffList          = lazy(() => import('./pages/Staff/StaffList.jsx'))
const Broadcasts         = lazy(() => import('./pages/Broadcasts.jsx'))
const RevenueDashboard   = lazy(() => import('./pages/Analytics/RevenueDashboard.jsx'))
const PurchaseOrdersList = lazy(() => import('./pages/PurchaseOrders/PurchaseOrdersList.jsx'))
const SchoolCatalogPage  = lazy(() => import('./pages/SchoolCatalog/SchoolCatalogPage.jsx'))

const PageLoader = () => (
  <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)' }}>
    <Spin size="large" />
  </div>
)

/** Old quotation-builder links open the quote's job page. */
function QuotationRedirect() {
  const { id } = useParams()
  return <Navigate to={`/jobs/${id}?tab=quote`} replace />
}

// The old Quotations / Orders lists are views of the Jobs board now.
const QUOTE_STATUS_TO_STATE = { draft: 'PRICING', sent: 'QUOTED', accepted: 'ACCEPTED', rejected: 'DECLINED', expired: 'EXPIRED' }
const ORDER_STAGE_TO_STATE = { deposit_pending: 'AWAITING_DEPOSIT', in_production: 'IN_PRODUCTION', ready: 'READY', completed: 'COMPLETED' }

/** /quotations[?status=draft] → /jobs?view=quotes[&state=PRICING]; /orders[?stage=…] → /jobs?view=orders[&state=…] */
function BoardViewRedirect({ view }) {
  const [params] = useSearchParams()
  const next = new URLSearchParams({ view })
  const state = view === 'quotes' ? QUOTE_STATUS_TO_STATE[params.get('status')] : ORDER_STAGE_TO_STATE[params.get('stage')]
  if (state) next.set('state', state)
  for (const k of ['q', 'search']) if (params.get(k)) next.set('q', params.get(k))
  return <Navigate to={`/jobs?${next.toString()}`} replace />
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/inbox" element={<InboxList />} />
            <Route path="/inbox/:id" element={<ConversationChat />} />
            <Route path="/jobs" element={<JobsBoard />} />
            <Route path="/jobs/:quotationId" element={<JobPage />} />
            <Route path="/quotations" element={<BoardViewRedirect view="quotes" />} />
            <Route path="/quotations/:id/build" element={<QuotationRedirect />} />
            <Route path="/orders" element={<BoardViewRedirect view="orders" />} />
            <Route path="/orders/:id" element={<OrderRedirect />} />
            <Route path="/purchase-orders" element={<PurchaseOrdersList />} />
            <Route path="/tickets" element={<TicketsList />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            <Route path="/clients" element={<ClientsList />} />
            <Route path="/clients/:id" element={<ClientDetail />} />
            <Route path="/products" element={<ProductsList />} />
            <Route path="/school-catalog" element={<SchoolCatalogPage />} />
            <Route path="/staff" element={<StaffList />} />
            <Route path="/broadcasts" element={<Broadcasts />} />
            <Route path="/analytics" element={<RevenueDashboard />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
