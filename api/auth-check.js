const { isAuthenticated } = require('./_auth');

module.exports = async (req, res) => {
  res.status(200).json({ ok: true, authenticated: isAuthenticated(req) });
};
