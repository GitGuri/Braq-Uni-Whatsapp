import { useState } from 'react';
import {
  App, Button, Table, Space, Modal, Form, Input, InputNumber,
  Select, Switch, Popconfirm, Typography,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listSchoolCatalog,
  createSchoolCatalogEntry,
  updateSchoolCatalogEntry,
  deleteSchoolCatalogEntry,
} from '../../api/schoolCatalog.js';
import { useCan } from '../../lib/useCan.js';
import { money } from '../../lib/format.js';
import { errorMessage } from '../../utils/errorMessage.js';

const { Text } = Typography;
const SIZES_PLACEHOLDER = 'XS, S, M, L, XL, XXL';
// Mirrors backend/src/routes/schoolCatalog.routes.js requireRole('admin', 'manager')

export default function SchoolCatalogPage() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const canEdit = useCan()('catalog.write');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filterSchool, setFilterSchool] = useState(undefined);
  const [form] = Form.useForm();

  // One request for everything; the school filter is applied client-side.
  const { data: allEntries = [], isLoading } = useQuery({
    queryKey: ['school-catalog'],
    queryFn: () => listSchoolCatalog(),
  });
  const schools = [...new Set(allEntries.map(e => e.school_name))].sort();
  const entries = filterSchool ? allEntries.filter(e => e.school_name === filterSchool) : allEntries;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['school-catalog'] });
  };

  const createMut = useMutation({
    mutationFn: createSchoolCatalogEntry,
    onSuccess: () => { invalidate(); closeModal(); message.success('Uniform added'); },
    onError: (err) => message.error(errorMessage(err, 'Could not add the uniform')),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }) => updateSchoolCatalogEntry(id, data),
    onSuccess: () => { invalidate(); closeModal(); message.success('Uniform updated'); },
    onError: (err) => message.error(errorMessage(err, 'Could not save the uniform')),
  });

  const deleteMut = useMutation({
    mutationFn: deleteSchoolCatalogEntry,
    onSuccess: () => { invalidate(); message.success('Uniform deleted'); },
    onError: (err) => message.error(errorMessage(err, 'Could not delete the uniform')),
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  }

  function openEdit(record) {
    setEditing(record);
    form.resetFields();
    form.setFieldsValue({
      schoolName: record.school_name,
      uniformType: record.uniform_type,
      description: record.description || '',
      sizes: Array.isArray(record.sizes) ? record.sizes.join(', ') : '',
      price: parseFloat(record.price),
      currency: record.currency || 'ZAR',
      sortOrder: record.sort_order ?? 0,
      isActive: record.is_active !== false,
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    form.resetFields();
  }

  function handleSubmit(values) {
    const payload = {
      schoolName: values.schoolName.trim(),
      uniformType: values.uniformType.trim(),
      description: values.description?.trim() || null,
      sizes: values.sizes
        ? values.sizes.split(',').map(s => s.trim()).filter(Boolean)
        : [],
      price: values.price,
      currency: values.currency || 'ZAR',
      sortOrder: values.sortOrder ?? 0,
    };

    if (editing) {
      updateMut.mutate({ id: editing.id, data: { ...payload, isActive: values.isActive } });
    } else {
      createMut.mutate(payload);
    }
  }

  const columns = [
    {
      title: 'School',
      dataIndex: 'school_name',
      sorter: (a, b) => a.school_name.localeCompare(b.school_name),
      render: v => <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{v}</span>,
    },
    {
      title: 'Uniform',
      dataIndex: 'uniform_type',
    },
    {
      title: 'Description',
      dataIndex: 'description',
      render: v => v ? <span style={{ color: 'var(--ink-2)' }}>{v}</span> : <span style={{ color: 'var(--ink-3)' }}>—</span>,
      ellipsis: true,
    },
    {
      title: 'Sizes',
      dataIndex: 'sizes',
      render: sizes =>
        Array.isArray(sizes) && sizes.length
          ? <span style={{ color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{sizes.join(', ')}</span>
          : <span style={{ color: 'var(--ink-3)' }}>—</span>,
    },
    {
      title: 'Price',
      dataIndex: 'price',
      align: 'right',
      render: (v, r) => (
        <span style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>
          {money(v, { currency: r.currency })}
        </span>
      ),
      sorter: (a, b) => parseFloat(a.price) - parseFloat(b.price),
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      render: v => <span className={`braq-pill ${v ? 'green' : ''}`}>{v ? 'Active' : 'Hidden'}</span>,
    },
    ...(canEdit ? [{
      title: '',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            aria-label={`Edit ${record.uniform_type} for ${record.school_name}`}
            onClick={() => openEdit(record)}
          >
            Edit
          </Button>
          <Popconfirm
            title="Delete this uniform?"
            description="Parents will no longer be quoted for it on WhatsApp."
            onConfirm={() => deleteMut.mutate(record.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${record.uniform_type} for ${record.school_name}`}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    }] : []),
  ];

  return (
    <div>
      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">School catalog</h1>
          <div className="braq-page-subtitle">Uniform prices for each school. The WhatsApp assistant quotes parents from this list.</div>
        </div>
        <Space wrap>
          <Select
            allowClear
            aria-label="Filter by school"
            placeholder="All schools"
            style={{ width: 220 }}
            options={schools.map(s => ({ label: s, value: s }))}
            onChange={val => setFilterSchool(val)}
            value={filterSchool}
          />
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Add uniform
            </Button>
          )}
        </Space>
      </div>

      {!canEdit && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          You can view this list. Ask an admin or manager to change prices or add uniforms.
        </Text>
      )}

      <section className="braq-panel" style={{ overflow: 'hidden' }}>
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={entries}
          columns={columns}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          size="middle"
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: canEdit ? 'No uniforms yet. Use Add uniform to list the first one.' : 'No uniforms have been listed yet.' }}
        />
      </section>

      <Modal
        title={editing ? 'Edit uniform' : 'Add uniform'}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okText={editing ? 'Save changes' : 'Add uniform'}
        confirmLoading={createMut.isPending || updateMut.isPending}
        forceRender
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={{ currency: 'ZAR', sortOrder: 0, isActive: true }}
        >
          <Form.Item name="schoolName" label="School" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="e.g. Greenside High School" />
          </Form.Item>
          <Form.Item name="uniformType" label="Uniform" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="e.g. Boys Summer Shirt" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Optional" />
          </Form.Item>
          <Form.Item name="sizes" label="Sizes" extra="Separate sizes with commas">
            <Input placeholder={SIZES_PLACEHOLDER} />
          </Form.Item>
          <Form.Item name="price" label="Price" rules={[{ required: true }]}>
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="currency" label="Currency">
            <Select options={[{ label: 'ZAR', value: 'ZAR' }, { label: 'USD', value: 'USD' }]} />
          </Form.Item>
          <Form.Item name="sortOrder" label="Position in the list" extra="Lower numbers are listed first">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          {editing && (
            <Form.Item name="isActive" label="Show on WhatsApp" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
