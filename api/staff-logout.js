const { clearSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
};
