const errorHandler = (err, req, res, next) => {
    console.error('=== API ERROR LOG ===');
    console.error(err);
    console.error('=====================');

    let statusCode = err.statusCode || 500;
    let message = err.message || 'Internal Server Error';

    if (err.code === 11000) {
        statusCode = 400;
        const field = Object.keys(err.keyValue || {})[0] || 'Value';
        message = `${field.charAt(0).toUpperCase() + field.slice(1)} already exists.`;
    }
    if (err.name === 'ValidationError') {
        statusCode = 400;
        message = Object.values(err.errors).map((val) => val.message).join(', ');
    }
    if (err.name === 'CastError') {
        statusCode = 400;
        message = `Invalid ${err.path}`;
    }
    if (err.name === 'MulterError') {
        statusCode = 400;
        message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (photos up to 10 MB, documents up to 5 MB)' : err.message;
    }
    if (err.type === 'entity.parse.failed') {
        statusCode = 400;
        message = 'Invalid JSON in request body';
    }
    // Don't leak internals to clients in production
    if (statusCode === 500 && process.env.NODE_ENV === 'production') {
        message = 'Internal Server Error';
    }

    res.status(statusCode).json({ success: false, error: message });
};

module.exports = errorHandler;
