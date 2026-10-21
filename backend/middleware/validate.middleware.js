const { validationResult } = require('express-validator');

const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const list = errors.array();
        return res.status(400).json({
            success: false,
            // Shown as one readable message by the frontend (api.js reads data.error)
            error: list.map((e) => e.msg).join(', '),
            // express-validator v7 uses `path` (older versions used `param`)
            errors: list.map((e) => ({ field: e.path || e.param, message: e.msg }))
        });
    }
    next();
};

module.exports = validate;
