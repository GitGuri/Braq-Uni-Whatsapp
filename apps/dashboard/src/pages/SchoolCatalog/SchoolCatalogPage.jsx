import { useState } from 'react';
import {
  Button, Table, Tag, Space, Modal, Form, Input, InputNumber,
  Select, message, Popconfirm, Typography, Card,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listSchoolCatalog,
  createSchoolCatalogEntry,
  updateSchoolCatalogEntry,
  deleteSchoolCatalogEntry,
} from '../../api/schoolCatalog.js';

const { Title } = Typography;
const SIZES_PLACEHOLDER = 'XS, S, M, L, XL, XXL';

export default function SchoolCatalogPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filterSchool, setFilterSchool] = useState(undefined);
  const [form] = Form.useForm();

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['school-catalog', filterSchool],
    queryFn: () => listSchoolCatalog(filterSchool),
  });

  // Derive school list from loaded entries (avoids a separate request when filter is "All")
  const { data: allEntries = [] } = useQuery({
    queryKey: ['school-catalog'],
    queryFn: () => listSchoolCatalog(),
  });
  const schools = [...new Set(allEntries.map(e => e.school_name))].sort();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['school-catalog'] });
  };

  const createMut = useMutation({
    mutationFn: createSchoolCatalogEntry,
    onSuccess: () => { invalidate(); closeModal(); message.success('Entry created'); },
    onError: () => message.error('Failed to create entry'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }) => updateSchoolCatalogEntry(id, data),
    onSuccess: () => { invalidate(); closeModal(); message.success('Entry updated'); },
    onError: () => message.error('Failed to update entry'),
  });

  const deleteMut = useMutation({
    mutationFn: deleteSchoolCatalogEntry,
    onSuccess: () => { invalidate(); message.success('Entry deleted'); },
    onError: () => message.error('Failed to delete entry'),
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  }

  function openEdit(record) {
    setEditing(record);
    form.setFieldsValue({
      schoolName: record.school_name,
      uniformType: record.uniform_type,
      description: record.description || '',
      sizes: Array.isArray(record.sizes) ? record.sizes.join(', ') : '',
      price: parseFloat(record.price),
      currency: record.currency || 'ZAR',
      sortOrder: record.sort_order ?? 0,
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
      updateMut.mutate({ id: editing.id, data: payload });
    } else {
      createMut.mutate(payload);
    }
  }

  const columns = [
    {
      title: 'School',
      dataIndex: 'school_name',
      sorter: (a, b) => a.school_name.localeCompare(b.school_name),
    },
    {
      title: 'Uniform Type',
      dataIndex: 'uniform_type',
    },
    {
      title: 'Description',
      dataIndex: 'description',
      render: v => v || '—',
      ellipsis: true,
    },
    {
      title: 'Sizes',
      dataIndex: 'sizes',
      render: sizes =>
        Array.isArray(sizes) && sizes.length
          ? sizes.map(s => <Tag key={s}>{s}</Tag>)
          : '—',
    },
    {
      title: 'Price (ZAR)',
      dataIndex: 'price',
      render: v => `R ${parseFloat(v).toFixed(2)}`,
      sorter: (a, b) => parseFloat(a.price) - parseFloat(b.price),
    },
    {
      title: 'Active',
      dataIndex: 'is_active',
      render: v => <Tag color={v ? 'green' : 'red'}>{v ? 'Yes' : 'No'}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
          >
            Edit
          </Button>
          <Popconfirm
            title="Delete this entry?"
            onConfirm={() => deleteMut.mutate(record.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>School Catalog</Title>
          <Space>
            <Select
              allowClear
              placeholder="Filter by school"
              style={{ width: 220 }}
              options={schools.map(s => ({ label: s, value: s }))}
              onChange={val => setFilterSchool(val)}
              value={filterSchool}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Add Entry
            </Button>
          </Space>
        </div>

        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={entries}
          columns={columns}
          pagination={{ pageSize: 20 }}
          size="small"
        />
      </Card>

      <Modal
        title={editing ? 'Edit School Catalog Entry' : 'Add School Catalog Entry'}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending || updateMut.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={{ currency: 'ZAR', sortOrder: 0 }}
        >
          <Form.Item name="schoolName" label="School Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Greenside High School" />
          </Form.Item>
          <Form.Item name="uniformType" label="Uniform Type" rules={[{ required: true }]}>
            <Input placeholder="e.g. Boys Summer Shirt" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Optional description" />
          </Form.Item>
          <Form.Item name="sizes" label="Available Sizes (comma-separated)">
            <Input placeholder={SIZES_PLACEHOLDER} />
          </Form.Item>
          <Form.Item name="price" label="Price (ZAR)" rules={[{ required: true }]}>
            <InputNumber min={0} precision={2} style={{ width: '100%' }} prefix="R" />
          </Form.Item>
          <Form.Item name="currency" label="Currency">
            <Select options={[{ label: 'ZAR', value: 'ZAR' }, { label: 'USD', value: 'USD' }]} />
          </Form.Item>
          <Form.Item name="sortOrder" label="Sort Order">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
