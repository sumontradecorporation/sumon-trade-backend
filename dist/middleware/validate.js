/** Validates and replaces req.body with the parsed (stripped, coerced) value. */
export function validate(schema) {
    return (req, _res, next) => {
        req.body = schema.parse(req.body ?? {});
        next();
    };
}
//# sourceMappingURL=validate.js.map