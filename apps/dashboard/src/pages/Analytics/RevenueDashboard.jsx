import { useQuery } from '@tanstack/react-query'
import { Card, Row, Col, Statistic, Table, Tag, Typography, Spin, Progress } from 'antd'
import { RiseOutlined, UserOutlined, ShoppingOutlined, PercentageOutlined } from '@ant-design/icons'
import { getRevenueData, getTopClients, getTopProducts } from '../../api/analytics.js'

const { Title, Text } = Typography
const ACCENT = '#c0392b'

function fmt(n) {
  return `R ${Number(n ?? 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const STAGE_LABELS = {
  deposit_pending: 'Awaiting Deposit',
  in_production:   'In Production',
  ready:           'Ready / Dispatched',
}
const STAGE_COLORS = {
  deposit_pending: '#fa8c16',
  in_production:   '#1677ff',
  ready:           '#52c41a',
}

export default function RevenueDashboard() {
  const { data: rev, isLoading: revLoading } = useQuery({
    queryKey: ['analytics', 'revenue'],
    queryFn: getRevenueData,
  })
  const { data: clientsData, isLoading: clientsLoading } = useQuery({
    queryKey: ['analytics', 'top-clients'],
    queryFn: () => getTopClients(8),
  })
  const { data: productsData, isLoading: productsLoading } = useQuery({
    queryKey: ['analytics', 'top-products'],
    queryFn: () => getTopProducts(8),
  })

  const summary      = rev?.summary ?? {}
  const byMonth      = rev?.byMonth ?? []
  const conversion   = rev?.conversion ?? {}
  const stageCounts  = rev?.stageBreakdown ?? []
  const topClients   = clientsData?.clients ?? []
  const topProducts  = productsData?.products ?? []

  const maxMonthRevenue = Math.max(...byMonth.map((m) => Number(m.revenue)), 1)
  const maxClientSpend  = Math.max(...topClients.map((c) => Number(c.total_spent)), 1)
  const maxProductQty   = Math.max(...topProducts.map((p) => Number(p.total_qty)), 1)

  const totalPipelineOrders = stageCounts.reduce((s, r) => s + Number(r.count), 0)

  const clientColumns = [
    { title: 'Client', dataIndex: 'name',
      render: (v, r) => <><div style={{ fontWeight: 600 }}>{v ?? '—'}</div>{r.organisation && <Text type="secondary" style={{ fontSize: 11 }}>{r.organisation}</Text>}</> },
    { title: 'Orders', dataIndex: 'total_orders', width: 80, align: 'right',
      render: (v) => <Tag>{v}</Tag> },
    { title: 'Total Spent', dataIndex: 'total_spent', align: 'right', width: 160,
      render: (v) => <Text strong>{fmt(v)}</Text> },
  ]

  const productColumns = [
    { title: 'Product', dataIndex: 'product', render: (v) => <Text strong>{v}</Text> },
    { title: 'Total Qty', dataIndex: 'total_qty', align: 'right', width: 110,
      render: (v) => <><Text strong>{Number(v).toLocaleString()}</Text><Progress percent={Math.round(Number(v) / maxProductQty * 100)} showInfo={false} size="small" strokeColor={ACCENT} style={{ marginTop: 2 }} /></> },
    { title: 'Appearances', dataIndex: 'appearances', align: 'right', width: 120,
      render: (v) => <Text type="secondary">{v} orders</Text> },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 24 }}>Revenue Dashboard</Title>

      {revLoading ? <Spin /> : (
        <>
          {/* ── KPI Row ───────────────────────── */}
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic
                  title="This Month"
                  value={Number(summary.this_month ?? 0).toFixed(2)}
                  prefix={<RiseOutlined style={{ color: ACCENT }} />}
                  valueStyle={{ color: ACCENT }}
                  formatter={(v) => `R ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`}
                />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic
                  title="Last Month"
                  value={Number(summary.last_month ?? 0).toFixed(2)}
                  formatter={(v) => `R ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`}
                />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic
                  title="All-Time Revenue"
                  value={Number(summary.all_time ?? 0).toFixed(2)}
                  formatter={(v) => `R ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`}
                />
              </Card>
            </Col>
          </Row>

          {/* ── Monthly Chart (bar via divs) + Quotation Conversion ──────── */}
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={24} lg={16}>
              <Card title="Monthly Revenue (last 12 months)" bodyStyle={{ paddingBottom: 12 }}>
                {byMonth.length === 0 ? (
                  <Text type="secondary">No payment data yet.</Text>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 160, paddingBottom: 24, position: 'relative' }}>
                    {byMonth.map((m) => {
                      const pct = Math.round(Number(m.revenue) / maxMonthRevenue * 100)
                      const h   = Math.max(4, Math.round(pct / 100 * 120))
                      return (
                        <div key={m.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                          <Text style={{ fontSize: 9, color: '#555', writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}>
                            {fmt(m.revenue).replace('R ', 'R ')}
                          </Text>
                          <div
                            title={`${m.month}: ${fmt(m.revenue)}`}
                            style={{
                              width: '100%', height: h,
                              background: `linear-gradient(to top, ${ACCENT}cc, ${ACCENT}44)`,
                              borderRadius: '3px 3px 0 0',
                              cursor: 'default',
                            }}
                          />
                          <Text style={{ fontSize: 9, color: '#555' }}>{m.month.slice(5)}</Text>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            </Col>

            <Col xs={24} lg={8}>
              <Card title="Quotation Conversion" style={{ height: '100%' }}>
                <div style={{ textAlign: 'center', padding: '8px 0' }}>
                  <Progress
                    type="circle"
                    percent={Number(conversion.conversion_pct ?? 0)}
                    strokeColor={ACCENT}
                    size={100}
                    format={(p) => <span style={{ color: ACCENT, fontWeight: 700 }}>{p}%</span>}
                  />
                  <div style={{ marginTop: 16 }}>
                    <Row gutter={8}>
                      {[
                        { label: 'Total',    val: conversion.total,    color: '#555' },
                        { label: 'Accepted', val: conversion.accepted, color: '#52c41a' },
                        { label: 'Sent',     val: conversion.sent,     color: '#1677ff' },
                        { label: 'Rejected', val: conversion.rejected, color: ACCENT },
                      ].map(({ label, val, color }) => (
                        <Col span={12} key={label} style={{ marginBottom: 8 }}>
                          <Text style={{ fontSize: 11, color: '#555' }}>{label}</Text>
                          <div style={{ fontSize: 18, fontWeight: 700, color }}>{val ?? 0}</div>
                        </Col>
                      ))}
                    </Row>
                  </div>
                </div>
              </Card>
            </Col>
          </Row>

          {/* ── Active Order Pipeline ──────────── */}
          {stageCounts.length > 0 && (
            <Card title="Active Order Pipeline" style={{ marginBottom: 24 }}>
              <Row gutter={[12, 12]}>
                {stageCounts.map((s) => (
                  <Col xs={24} sm={8} key={s.stage}>
                    <div style={{
                      padding: '12px 16px', borderRadius: 8,
                      background: `${STAGE_COLORS[s.stage] ?? '#555'}18`,
                      border: `1px solid ${STAGE_COLORS[s.stage] ?? '#555'}44`,
                    }}>
                      <Text style={{ fontSize: 11, color: STAGE_COLORS[s.stage] ?? '#555', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        {STAGE_LABELS[s.stage] ?? s.stage}
                      </Text>
                      <div style={{ fontSize: 28, fontWeight: 700, color: STAGE_COLORS[s.stage] ?? '#e8e8e8', lineHeight: 1.2, marginTop: 4 }}>
                        {s.count}
                      </div>
                      <Progress
                        percent={totalPipelineOrders ? Math.round(s.count / totalPipelineOrders * 100) : 0}
                        showInfo={false}
                        size="small"
                        strokeColor={STAGE_COLORS[s.stage] ?? ACCENT}
                        style={{ marginTop: 6, marginBottom: 0 }}
                      />
                    </div>
                  </Col>
                ))}
              </Row>
            </Card>
          )}
        </>
      )}

      {/* ── Top Clients / Products ──────────────────────────────────────── */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={<><UserOutlined style={{ color: ACCENT, marginRight: 6 }} />Top Clients by Spend</>} bodyStyle={{ padding: 0 }}>
            <Table
              dataSource={topClients}
              columns={clientColumns}
              rowKey="id"
              loading={clientsLoading}
              size="small"
              pagination={false}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={<><ShoppingOutlined style={{ color: ACCENT, marginRight: 6 }} />Best-Selling Products</>} bodyStyle={{ padding: 0 }}>
            <Table
              dataSource={topProducts}
              columns={productColumns}
              rowKey="product"
              loading={productsLoading}
              size="small"
              pagination={false}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
