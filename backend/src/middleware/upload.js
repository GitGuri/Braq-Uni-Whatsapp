import multer from 'multer';

const SIZE_FILE_MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIMETYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel', // some browsers report .csv as this
];
// Generic types some clients send; accepted only with a matching extension.
const GENERIC_MIMETYPES = ['application/octet-stream', 'text/plain'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isSizeFile(file) {
  if (ALLOWED_MIMETYPES.includes(file.mimetype)) return true;
  const name = (file.originalname || '').toLowerCase();
  if (file.mimetype === 'text/plain') return name.endsWith('.csv');
  return GENERIC_MIMETYPES.includes(file.mimetype) && (name.endsWith('.csv') || name.endsWith('.xlsx'));
}

/** Map a multer / fileFilter error to { status, message } for the client. */
export function uploadErrorResponse(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return { status: 413, message: 'File too large' };
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return { status: 400, message: `Unexpected file field "${err.field}"` };
    return { status: 400, message: err.message || 'Invalid upload' };
  }
  if (err?.status >= 400 && err.status < 500) return { status: err.status, message: err.message };
  return { status: 400, message: err?.message || 'Invalid upload' };
}

/** Wrap a multer middleware so upload errors become 4xx JSON responses instead of 500s. */
export function withUploadErrors(mw) {
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (!err) return next();
      const { status, message } = uploadErrorResponse(err);
      return res.status(status).json({ error: message });
    });
  };
}

// Roster upload (.xlsx / .csv, field "file", max 5 MB). Raw multer middleware:
// errors go to next(err). Mount it as withUploadErrors(uploadSizeFile) to map
// them: wrong type → 415, too large → 413, other multipart problems → 400.
export const uploadSizeFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE_FILE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isSizeFile(file)) {
      return cb(httpError(415, 'Only .xlsx or .csv files are accepted'));
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
