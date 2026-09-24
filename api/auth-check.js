const { getSessionUser } = require('./_auth');

module.exports = async (req, res) => {
  const sessionUser = getSessionUser(req);
  res.status(200).json({
    ok: true,
    authenticated: !!sessionUser,
    role: sessionUser ? sessionUser.role : null,
    username: sessionUser ? sessionUser.username : null,
  });
};
