// Password hashing for staff_users, using Node's built-in scrypt --
// no external dependency needed. Each password gets its own random
// salt; the hash and salt are stored separately (both hex) so two
// staff with the same password never produce the same stored hash.

const crypto = require('crypto');

const KEY_LENGTH = 64;

function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plainPassword, salt, KEY_LENGTH).toString('hex');
  return { hash, salt };
}

function verifyPassword(plainPassword, storedHash, storedSalt) {
  if (!storedHash || !storedSalt) return false;
  const candidateHash = crypto.scryptSync(plainPassword, storedSalt, KEY_LENGTH).toString('hex');
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, verifyPassword };
