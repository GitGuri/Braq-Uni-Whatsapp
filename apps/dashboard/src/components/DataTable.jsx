import { useState } from 'react'
import { Table, Typography } from 'antd'
import {
  SearchOutlined, PlusOutlined, FilterOutlined, DownOutlined,
  EditOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined,
  CrownOutlined, EyeOutlined, InfoCircleOutlined,
  LeftOutlined, RightOutlined,
} from '@ant-design/icons'

const { Text } = Typography
const ACCENT = '#c0392b'

// ── Sample data (10 rows) ─────────────────────────────────────────────────────
const ROWS = [
  { id: '1',  name: 'Amara Diallo',       email: 'amara.d@nexus.io',     av: 'AD', role: 'editor', tier: 'Pro',        rating: 9.2, trend: 'up',   flag: '🇸🇳', country: 'Senegal',        status: 'active'    },
  { id: '2',  name: 'Chen Wei',            email: 'chen.w@nexus.io',      av: 'CW', role: 'admin',  tier: 'Enterprise', rating: 8.8, trend: 'up',   flag: '🇨🇳', country: 'China',          status: 'active'    },
  { id: '3',  name: 'Fatima Al-Rashid',    email: 'fatima.ar@nexus.io',   av: 'FA', role: 'viewer', tier: 'Starter',    rating: 5.4, trend: 'down', flag: '🇦🇪', country: 'UAE',            status: 'inactive'  },
  { id: '4',  name: 'Olusegun Adeyemi',    email: 'olusegun.a@nexus.io',  av: 'OA', role: 'editor', tier: 'Pro',        rating: 7.6, trend: 'up',   flag: '🇳🇬', country: 'Nigeria',        status: 'active'    },
  { id: '5',  name: 'Sarah Müller',         email: 'sarah.m@nexus.io',     av: 'SM', role: 'admin',  tier: 'Enterprise', rating: 9.5, trend: 'up',   flag: '🇩🇪', country: 'Germany',        status: 'active'    },
  { id: '6',  name: 'Priya Krishnan',      email: 'priya.k@nexus.io',     av: 'PK', role: 'viewer', tier: 'Starter',    rating: 4.1, trend: 'down', flag: '🇮🇳', country: 'India',          status: 'suspended' },
  { id: '7',  name: 'Marcus Webb',          email: 'marcus.w@nexus.io',    av: 'MW', role: 'editor', tier: 'Pro',        rating: 8.0, trend: 'up',   flag: '🇬🇧', country: 'United Kingdom', status: 'active'    },
  { id: '8',  name: 'Aisha Mwangi',        email: 'aisha.m@nexus.io',     av: 'AM', role: 'admin',  tier: 'Enterprise', rating: 7.3, trend: 'down', flag: '🇰🇪', country: 'Kenya',          status: 'active'    },
  { id: '9',  name: 'Dmitri Volkov',       email: 'dmitri.v@nexus.io',    av: 'DV', role: 'viewer', tier: 'Free',       rating: 3.9, trend: 'down', flag: '🇷🇺', country: 'Russia',         status: 'inactive'  },
  { id: '10', name: 'Isabella Reyes',      email: 'isabella.r@nexus.io',  av: 'IR', role: 'editor', tier: 'Pro',        rating: 8.7, trend: 'up',   flag: '🇨🇴', country: 'Colombia',       status: 'active'    },
]

const ROLE = {
  admin:  { label: 'Admin',  icon: <CrownOutlined />,   bg: 'rgba(212,160,23,0.12)',   color: '#d4a017' },
  editor: { label: 'Editor', icon: <EditOutlined />,    bg: 'rgba(59,130,246,0.12)',   color: '#3b82f6' },
  viewer: { label: 'Viewer', icon: <EyeOutlined />,     bg: 'rgba(107,114,128,0.12)', color: '#6b7280' },
}

const STATUS = {
  active:    { dot: '#22c55e', label: 'Active'    },
  inactive:  { dot: '#3a3a3a', label: 'Inactive'  },
  suspended: { dot: ACCENT,    label: 'Suspended' },
}

const PAGE_SIZE  = 10
const TOTAL_ROWS = 1000

// ── Shared button factories ───────────────────────────────────────────────────
function TblBtn({ danger, children, onClick }) {
  const [hov, setHov] = useState(false)
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '8px 12px', borderRadius: 6, fontFamily: 'inherit',
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    transition: 'all 0.13s', whiteSpace: 'nowrap',
  }
  const style = danger
    ? { ...base, background: hov ? '#a93226' : ACCENT, color: '#fff', border: `1px solid ${ACCENT}` }
    : { ...base, background: 'transparent', color: hov ? '#e8e8e8' : '#888', border: `1px solid ${hov ? '#3a3a3a' : '#252525'}` }
  return (
    <button style={style} onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      {children}
    </button>
  )
}

function PageBtn({ children, active, disabled, onClick }) {
  const [hov, setHov] = useState(false)
  const style = {
    minWidth: 30, height: 30, display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', borderRadius: 6, padding: '0 7px',
    fontSize: 12, fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
    border: '1px solid',
    background: active ? ACCENT    : 'transparent',
    borderColor: active ? ACCENT   : disabled ? '#1a1a1a' : hov ? '#3a3a3a' : '#252525',
    color:       active ? '#fff'   : disabled ? '#2a2a2a' : hov ? '#ccc' : '#555',
    transition: 'all 0.13s',
  }
  return (
    <button style={style} onClick={!disabled ? onClick : undefined}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}>
      {children}
    </button>
  )
}

// ── Toolbar input ─────────────────────────────────────────────────────────────
function SearchBar({ value, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flex: 1,
      background: '#0d0d0d', border: '1px solid #252525', borderRadius: 6,
      padding: '8px 10px',
    }}>
      <SearchOutlined style={{ color: '#3a3a3a', fontSize: 13, flexShrink: 0 }} />
      <input
        value={value} onChange={e => onChange(e.target.value)}
        placeholder="Search by name or email…"
        style={{
          background: 'none', border: 'none', outline: 'none',
          color: '#e8e8e8', fontSize: 12, width: '100%', fontFamily: 'inherit',
        }}
      />
    </div>
  )
}

function ToolbarBtn({ icon, label, primary, chevron }) {
  const [hov, setHov] = useState(false)
  const style = primary
    ? {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 6, border: 'none',
        background: hov ? '#a93226' : ACCENT, color: '#fff',
        fontSize: 12, fontWeight: 500, cursor: 'pointer',
        fontFamily: 'inherit', transition: 'background 0.13s', flexShrink: 0,
      }
    : {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 6, border: `1px solid ${hov ? '#333' : '#252525'}`,
        background: 'transparent', color: hov ? '#aaa' : '#666',
        fontSize: 12, fontWeight: 500, cursor: 'pointer',
        fontFamily: 'inherit', transition: 'all 0.13s', flexShrink: 0,
      }
  return (
    <button style={style}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      {icon && <span style={{ fontSize: 11 }}>{icon}</span>}
      {label}
      {chevron && <DownOutlined style={{ fontSize: 9 }} />}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DataTable() {
  const [search,  setSearch]  = useState('')
  const [page,    setPage]    = useState(1)

  const filtered = ROWS.filter(r =>
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.email.toLowerCase().includes(search.toLowerCase())
  )

  const columns = [
    {
      title: 'Name',
      key: 'name',
      width: 230,
      render: (_, r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
            background: '#1c1c1c', border: '1px solid #2a2a2a',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#666',
          }}>{r.av}</div>
          <div>
            <Text strong style={{ fontSize: 13, color: '#e8e8e8', display: 'block', lineHeight: 1.3 }}>
              {r.name}
            </Text>
            <Text style={{ fontSize: 11, color: '#4a4a4a', lineHeight: 1.3 }}>
              {r.email}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: 'Role',
      key: 'role',
      width: 110,
      render: (_, r) => {
        const c = ROLE[r.role]
        return (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 9px', borderRadius: 20,
            background: c.bg, color: c.color, fontSize: 11, fontWeight: 600,
          }}>
            {c.icon} {c.label}
          </span>
        )
      },
    },
    {
      title: 'Email',
      key: 'email',
      width: 210,
      render: (_, r) => (
        <Text style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>{r.email}</Text>
      ),
    },
    {
      title: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          Type <InfoCircleOutlined style={{ fontSize: 11, opacity: 0.35 }} />
        </span>
      ),
      key: 'tier',
      width: 115,
      render: (_, r) => (
        <Text style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>{r.tier}</Text>
      ),
    },
    {
      title: <span>Rating <span style={{ opacity: 0.3, fontSize: 10 }}>↕</span></span>,
      key: 'rating',
      width: 100,
      render: (_, r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontVariantNumeric: 'tabular-nums' }}>
          <Text style={{ fontSize: 13, color: '#e8e8e8', fontWeight: 600 }}>
            {r.rating.toFixed(1)}
          </Text>
          {r.trend === 'up'
            ? <ArrowUpOutlined   style={{ color: '#22c55e', fontSize: 10 }} />
            : <ArrowDownOutlined style={{ color: ACCENT,    fontSize: 10 }} />}
        </span>
      ),
    },
    {
      title: 'Country',
      key: 'country',
      width: 160,
      render: (_, r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>{r.flag}</span>
          <Text style={{ fontSize: 12, color: '#888' }}>{r.country}</Text>
        </span>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, r) => {
        const s = STATUS[r.status]
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: s.dot, flexShrink: 0,
              boxShadow: r.status === 'active' ? `0 0 0 3px rgba(34,197,94,0.15)` : 'none',
            }} />
            <Text style={{ fontSize: 12, color: '#777', whiteSpace: 'nowrap' }}>{s.label}</Text>
          </span>
        )
      },
    },
    {
      title: '',
      key: 'actions',
      width: 165,
      render: () => (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <TblBtn><EditOutlined style={{ fontSize: 11 }} /> Edit</TblBtn>
          <TblBtn danger><DeleteOutlined style={{ fontSize: 11 }} /> Delete</TblBtn>
        </span>
      ),
    },
  ]

  const totalPages = Math.ceil(TOTAL_ROWS / PAGE_SIZE)
  const pageNums   = [1, 2, 3, 4, 5]
  const rangeStart = (page - 1) * PAGE_SIZE + 1
  const rangeEnd   = Math.min(page * PAGE_SIZE, TOTAL_ROWS)

  return (
    <div style={{
      background: '#141414',
      borderRadius: 12,
      border: '1px solid #1e1e1e',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    }}>

      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 16px',
        borderBottom: '1px solid #1e1e1e',
      }}>
        <SearchBar value={search} onChange={setSearch} />
        <ToolbarBtn primary icon={<PlusOutlined />} label="Add item" />
        <ToolbarBtn icon={<FilterOutlined />} label="Filters" chevron />
        <ToolbarBtn label="Actions" chevron />
      </div>

      {/* ── Table ── */}
      <Table
        dataSource={filtered}
        columns={columns}
        rowKey="id"
        size="middle"
        scroll={{ x: 'max-content' }}
        pagination={false}
        style={{ fontSize: 13 }}
        rowClassName={() => 'braq-dt-row'}
      />

      {/* ── Footer / Pagination ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderTop: '1px solid #1a1a1a',
      }}>
        <Text style={{ fontSize: 12, color: '#444' }}>
          Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {TOTAL_ROWS.toLocaleString()}
        </Text>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <PageBtn disabled={page === 1}        onClick={() => setPage(p => p - 1)}>
            <LeftOutlined style={{ fontSize: 10 }} />
          </PageBtn>

          {pageNums.map(n => (
            <PageBtn key={n} active={n === page} onClick={() => setPage(n)}>{n}</PageBtn>
          ))}

          <span style={{ color: '#2a2a2a', padding: '0 3px', fontSize: 13 }}>…</span>

          <PageBtn onClick={() => setPage(totalPages)}>{totalPages}</PageBtn>

          <PageBtn disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
            <RightOutlined style={{ fontSize: 10 }} />
          </PageBtn>
        </div>
      </div>
    </div>
  )
}
