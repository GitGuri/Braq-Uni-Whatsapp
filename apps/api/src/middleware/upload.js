import multer from 'multer';

const ALLOWED_MIMETYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel', // some browsers report .csv as this
];

export const uploadSizeFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
      return cb(new Error('Only .xlsx or .csv files are accepted'));
    }
    cb(null, true);
  },
}).single('file');

const ATTACHMENT_MIMETYPES = [
  'image/jpeg', 'image/png', 'image/webp',
  'application/pdf',
];

export const uploadAttachment = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (!ATTACHMENT_MIMETYPES.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, WebP, or PDF files are accepted'));
    }
    cb(null, true);
  },
}).single('attachment');
