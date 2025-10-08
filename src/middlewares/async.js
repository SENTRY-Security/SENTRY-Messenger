export const asyncH = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};