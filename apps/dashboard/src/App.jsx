import { Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './auth/ProtectedRoute.jsx'
import DashboardLayout from './layouts/DashboardLayout.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import OrdersList from './pages/Orders/OrdersList.jsx'
import OrderDetail from './pages/Orders/OrderDetail.jsx'
import ClientsList from './pages/Clients/ClientsList.jsx'
import ClientDetail from './pages/Clients/ClientDetail.jsx'
import QuotationsList from './pages/Quotations/QuotationsList.jsx'
import ProductsList from './pages/Products/ProductsList.jsx'
import PurchaseOrdersList from './pages/PurchaseOrders/PurchaseOrdersList.jsx'
import TicketsList from './pages/Tickets/TicketsList.jsx'
import TicketDetail from './pages/Tickets/TicketDetail.jsx'
import Broadcasts from './pages/Broadcasts.jsx'
import InboxList from './pages/Inbox/InboxList.jsx'
import ConversationChat from './pages/Inbox/ConversationChat.jsx'
import SchoolCatalogPage from './pages/SchoolCatalog/SchoolCatalogPage.jsx'
import StaffList from './pages/Staff/StaffList.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<DashboardLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/orders" element={<OrdersList />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/clients" element={<ClientsList />} />
          <Route path="/clients/:id" element={<ClientDetail />} />
          <Route path="/quotations" element={<QuotationsList />} />
          <Route path="/products" element={<ProductsList />} />
          <Route path="/purchase-orders" element={<PurchaseOrdersList />} />
          <Route path="/tickets" element={<TicketsList />} />
          <Route path="/tickets/:id" element={<TicketDetail />} />
          <Route path="/broadcasts" element={<Broadcasts />} />
          <Route path="/inbox" element={<InboxList />} />
          <Route path="/inbox/:id" element={<ConversationChat />} />
          <Route path="/school-catalog" element={<SchoolCatalogPage />} />
          <Route path="/staff" element={<StaffList />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
